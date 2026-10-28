import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Lint of the GitHub workflows. This test and review of changes under .github/ are the real control against a bad
 * workflow edit (docs/ENCRYPTED-LOGS-COLLECTOR.md, c3). The strict rules apply to the collector and keepalive files.
 */
const DIR = '.github/workflows';
type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string>; [k: string]: unknown };
type Job = { permissions?: unknown; steps?: Step[]; uses?: string; environment?: unknown; needs?: unknown; if?: string; [k: string]: unknown };
type Wf = { on?: unknown; permissions?: unknown; concurrency?: { group?: string; 'cancel-in-progress'?: boolean }; jobs?: Record<string, Job>; [k: string]: unknown };

const load = (f: string): { text: string; wf: Wf } => {
  const text = readFileSync(join(DIR, f), 'utf8');
  return { text, wf: parse(text) as Wf };
};
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const STRICT = ['collector.yml', 'keepalive.yml'];
const steps = (wf: Wf): Array<{ job: string; step: Step }> => Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => (j.steps ?? []).map((step) => ({ job, step })));
const stepText = (s: Step): string => JSON.stringify(s);
const readOnly = (p: unknown): boolean => p !== null && typeof p === 'object' && Object.values(p as object).every((v) => v === 'read' || v === 'none');

describe('all workflows', () => {
  it('finds the expected workflow files', () => {
    for (const f of STRICT) expect(files).toContain(f);
  });
  for (const f of files) {
    describe(f, () => {
      const { text, wf } = load(f);
      it('has no pull_request_target or workflow_run trigger and no secrets: inherit', () => {
        const on = Object.keys((wf.on ?? {}) as object);
        expect(on).not.toContain('pull_request_target');
        expect(on).not.toContain('workflow_run');
        expect(text).not.toMatch(/secrets:\s*inherit/);
      });
      it('pins every action to a 40-hex commit SHA, no local or digest-less docker actions, no actions/cache', () => {
        const uses = [...steps(wf).map((s) => s.step.uses), ...Object.values(wf.jobs ?? {}).map((j) => j.uses)].filter((u): u is string => typeof u === 'string');
        for (const u of uses) {
          expect(u, u).not.toMatch(/^\.\//);
          expect(u, u).not.toMatch(/^docker:\/\/(?!.*@sha256:[0-9a-f]{64})/);
          if (!u.startsWith('docker://')) expect(u, u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
          expect(u, u).not.toMatch(/^actions\/cache(\/|@)/);
        }
      });
      it('gives every job a permissions block (top level or per job) that is not write-all', () => {
        expect(JSON.stringify(wf)).not.toMatch(/write-all/);
        for (const [name, job] of Object.entries(wf.jobs ?? {})) expect(wf.permissions !== undefined || job.permissions !== undefined, name).toBe(true);
      });
      it('uploads artifacts with retention-days 1 in the strict files (the older public-data workflows keep the default)', () => {
        if (!STRICT.includes(f)) return;
        for (const { step } of steps(wf)) if (step.uses?.startsWith('actions/upload-artifact@')) expect(step.with?.['retention-days']).toBe(1);
      });
    });
  }
});

describe('collector and keepalive (strict)', () => {
  for (const f of STRICT) {
    describe(f, () => {
      const { wf } = load(f);
      const all = steps(wf);
      it('allows only schedule and workflow_dispatch without inputs', () => {
        const on = wf.on as Record<string, unknown>;
        expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch']);
        const wd = on.workflow_dispatch;
        expect(wd === null || (typeof wd === 'object' && Object.keys(wd as object).length === 0)).toBe(true);
      });
      it('has top-level permissions {} or read-only and an explicit permissions block per job', () => {
        expect(wf.permissions === undefined ? false : Object.keys(wf.permissions as object).length === 0 || readOnly(wf.permissions)).toBe(true);
        for (const [name, job] of Object.entries(wf.jobs ?? {})) expect(job.permissions, name).toBeTypeOf('object');
      });
      it('uses no expression inside a run script (no github.event or other injected text)', () => {
        for (const { step } of all) if (step.run) expect(step.run, step.name).not.toContain('${{');
      });
      it('never uses set -x, printenv or a bare env command in a run script', () => {
        for (const { step } of all) {
          if (!step.run) continue;
          expect(step.run, step.name).not.toMatch(/set\s+-\w*x|xtrace/);
          expect(step.run, step.name).not.toMatch(/(^|[\n;&|(]\s*)(printenv|env)(\s|$)/);
        }
      });
      it('keeps secrets.STATE_KEY to the rotate, collect and seal steps and nothing else from secrets', () => {
        const allowedIds = new Set(['rotate', 'collect', 'seal']);
        for (const { step } of all) {
          const t = stepText(step);
          const refs = [...t.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
          for (const r of refs) {
            expect(r).toBe('STATE_KEY');
            expect(allowedIds.has(step.id ?? ''), `${step.id} uses a secret`).toBe(true);
          }
          expect(t).not.toMatch(/secrets\.GITHUB_TOKEN/);
          expect(t).not.toMatch(/secrets\[/);
        }
      });
      it('passes github.token only to the push, read, alert and enable steps', () => {
        const allowedIds = new Set(['read', 'push-state', 'push-logs', 'push-cursor', 'alert', 'enable']);
        for (const { step } of all) if (stepText(step).includes('github.token')) expect(allowedIds.has(step.id ?? ''), String(step.id)).toBe(true);
      });
      it('uses actions/checkout with persist-credentials false and no cache input', () => {
        for (const { step } of all) {
          if (step.uses?.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
          if (step.uses?.startsWith('actions/setup-node@')) expect(step.with?.cache).toBeUndefined();
        }
      });
      it('starts every job that has a repository to guard with a guard step on repository, branch and event', () => {
        for (const [name, job] of Object.entries(wf.jobs ?? {})) {
          const first = (job.steps ?? [])[0]!;
          expect(first.run ?? '', name).toContain('GITHUB_REPOSITORY');
          if (name !== 'alert') {
            expect(first.run, name).toContain('GITHUB_REF');
            expect(first.run, name).toContain('GITHUB_EVENT_NAME');
          }
        }
      });
    });
  }

  describe('collector.yml specifics', () => {
    const { wf } = load('collector.yml');
    const collect = wf.jobs!.collect!;
    const alert = wf.jobs!.alert!;
    it('has one concurrency group without cancellation, the restricted environment and the enable switch', () => {
      expect(wf.concurrency?.group).toBe('collector');
      expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
      expect(collect.environment).toBe('collector');
      expect(collect.if).toContain("vars.COLLECTOR_ENABLED == 'true'");
    });
    it('gives collect contents:write only and alert issues:write only, with no secrets in the alert job', () => {
      expect(collect.permissions).toEqual({ contents: 'write' });
      expect(alert.permissions).toEqual({ issues: 'write' });
      expect(JSON.stringify(alert)).not.toContain('secrets.');
      expect(alert.steps!.some((s) => s.uses?.startsWith('actions/checkout'))).toBe(false);
      expect(alert.needs).toBe('collect');
      expect(alert.if).toBe('failure()');
    });
    it('runs the steps in the designed order', () => {
      const ids = collect.steps!.map((s) => s.id).filter(Boolean);
      expect(ids).toEqual(['read', 'rotate', 'backup', 'push-state', 'collect', 'push-logs', 'seal', 'push-cursor']);
    });
    it('treats the cursor seal and push as warnings only', () => {
      const byId = Object.fromEntries(collect.steps!.map((s) => [s.id, s]));
      expect(byId.seal!['continue-on-error']).toBe(true);
      expect(byId['push-cursor']!['continue-on-error']).toBe(true);
      for (const id of ['read', 'rotate', 'backup', 'push-state', 'collect', 'push-logs']) expect(byId[id]!['continue-on-error']).toBeUndefined();
    });
    it('keeps state and the token file under RUNNER_TEMP, never in the checkout', () => {
      for (const s of collect.steps!) for (const v of Object.values(s.env ?? {})) if (/FILE|OUT|DIR/.test(Object.keys(s.env ?? {}).find((k) => s.env![k] === v) ?? '')) expect(v).toContain('runner.temp');
    });
    it('backs up the rotated ciphertext right after rotate, before any push, and only when rotated', () => {
      const ids = collect.steps!.map((s) => s.id);
      expect(ids.indexOf('backup')).toBe(ids.indexOf('rotate') + 1);
      expect(ids.indexOf('backup')).toBeLessThan(ids.indexOf('push-state'));
      expect(collect.steps![ids.indexOf('backup')]!.if).toContain("steps.rotate.outputs.rotated == 'true'");
    });
    it('uploads only the sealed state artifact', () => {
      const up = collect.steps!.filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
      expect(up).toHaveLength(1);
      expect(String(up[0]!.with?.path)).toContain('oauth.enc.json');
    });
  });

  describe('keepalive.yml specifics', () => {
    const { wf } = load('keepalive.yml');
    it('has only actions:write and no environment or secrets', () => {
      expect(wf.jobs!.keepalive!.permissions).toEqual({ actions: 'write' });
      expect(wf.jobs!.keepalive!.environment).toBeUndefined();
      expect(JSON.stringify(wf)).not.toContain('secrets.');
    });
  });
});
