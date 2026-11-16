import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatedRulesBlockedError, desiredRules } from '../src/desiredrules.js';
import { DATED_RULES_BLOCKED, KNOWN_ISSUE_EXIT, KNOWN_ISSUE_URL, SAMSUNG_TICKET, datedRulesBlockedMessage } from '../src/knownissue.js';
import type { EveryAction } from '../src/rules.js';

const weeklyOptions = { deviceId: 'dev-1' };
const dated = [{ every: { specific: { year: 2027, month: 1, day: 1 } } }] as unknown as EveryAction[];

describe('known issue #63: dated rules blocked, weekly rules unaffected', () => {
  it('is switched on', () => expect(DATED_RULES_BLOCKED).toBe(true));
  it('message cites the issue and the ticket', () => {
    const m = datedRulesBlockedMessage();
    expect(m).toContain(KNOWN_ISSUE_URL);
    expect(m).toContain(SAMSUNG_TICKET);
  });
  it('dated only request throws', () => {
    expect(() => desiredRules({ weekly: false, weeklyOptions, holidayActions: dated, blocked: true })).toThrow(DatedRulesBlockedError);
  });
  it('weekly request while blocked yields only the weekly rule (Fri ON, Sat OFF)', () => {
    const r = desiredRules({ weekly: true, weeklyOptions, holidayActions: dated, blocked: true });
    expect(r.datedSkipped).toBe(true);
    expect(r.rules.map((x) => x.name)).toEqual(['shabbat-fridge weekly']);
    expect(r.rules[0]!.actions).toHaveLength(2);
  });
  it('unblocked request yields weekly plus dated rules', () => {
    const r = desiredRules({ weekly: true, weeklyOptions, holidayActions: dated, blocked: false });
    expect(r.datedSkipped).toBe(false);
    expect(r.rules.map((x) => x.name)).toEqual(['shabbat-fridge weekly', 'shabbat-fridge holidays 2027']);
  });
  it('unblocked dated only is allowed', () => {
    expect(desiredRules({ weekly: false, weeklyOptions, holidayActions: dated, blocked: false }).rules).toHaveLength(1);
  });
});

const run = (script: string, env: Record<string, string>) =>
  spawnSync('npx', ['--no-install', 'tsx', script], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8' });
const base = { START: '2026-11-01', YEARS: '1', LAT: '31.7', LON: '35.2', TZ: 'Asia/Jerusalem', DEVICE_ID: 'dev-1', CROSSCHECK: 'false' };

describe('scripts', () => {
  it('generate.ts without weekly exits 3, cites the issue and writes no file', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ki-')), 'o.json');
    const r = run('scripts/generate.ts', { ...base, OUT: out });
    expect(r.status).toBe(KNOWN_ISSUE_EXIT);
    expect(r.stderr).toContain(KNOWN_ISSUE_URL);
    expect(r.stderr).toContain(SAMSUNG_TICKET);
    expect(existsSync(out)).toBe(false);
  });
  it('generate.ts with WEEKLY_RULES=true writes only the weekly rule', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ki-')), 'o.json');
    const r = run('scripts/generate.ts', { ...base, OUT: out, WEEKLY_RULES: 'true' });
    expect(r.status).toBe(0);
    const rules = JSON.parse(readFileSync(out, 'utf8')) as { name: string; actions: unknown[] }[];
    expect(rules.map((x) => x.name)).toEqual(['shabbat-fridge weekly']);
    expect(rules[0]!.actions).toHaveLength(2);
    expect(r.stdout).toContain(KNOWN_ISSUE_URL);
  });
  it('install.ts without weekly exits 3 before any network call', () => {
    const r = run('scripts/install.ts', { ...base });
    expect(r.status).toBe(KNOWN_ISSUE_EXIT);
    expect(r.stderr).toContain(KNOWN_ISSUE_URL);
  });
});
