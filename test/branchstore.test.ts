import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BranchStore, MAX_PUSH_TRIES, STATE_FILE } from '../src/branchstore.js';

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function setup(name = 'CANARY-remote') {
  const root = mkdtempSync(join(tmpdir(), 'bst-'));
  const remote = join(root, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', work]);
  return { root, remote, work, store: new BranchStore({ repoDir: work, remote }) };
}
const name = (c: string) => `chunks/${c.repeat(32)}.bin`;
const files = (r: string, ref: string) => sh(r, 'ls-tree', '-r', '--name-only', ref).split('\n');
const log = (r: string, ref: string) => sh(r, 'log', '--format=%an|%ae|%cn|%ce|%s|%P', ref).split('\n');

describe('state branch', () => {
  it('reads null when absent, creates with an expected-absent lease, and reads back', () => {
    const { remote, store } = setup();
    expect(store.readState()).toBeNull();
    const sha = store.writeState('v1', null);
    const r = store.readState()!;
    expect(r.sha).toBe(sha);
    expect(r.content).toBe('v1');
    expect(files(remote, 'state')).toEqual([STATE_FILE]);
  });
  it('every write is a new parentless commit with the fixed message and identity; the branch has one commit', () => {
    const { remote, store } = setup();
    let sha = store.writeState('v1', null);
    for (const v of ['v2', 'v3']) sha = store.writeState(v, sha);
    expect(log(remote, 'state')).toEqual(['fridge-logs|fridge-logs@users.noreply.github.com|fridge-logs|fridge-logs@users.noreply.github.com|state|']);
    expect(files(remote, 'state')).toEqual([STATE_FILE]);
    expect(store.readState()!.content).toBe('v3');
  });
  it('a second write in the same run uses the sha returned by the first', () => {
    const { store } = setup();
    const a = store.writeState('first', null);
    const b = store.writeState('second', a);
    expect(a).not.toBe(b);
    expect(store.readState()!.sha).toBe(b);
  });
  it('a stale lease fails and leaves the remote unchanged', () => {
    const { store } = setup();
    const a = store.writeState('v1', null);
    store.writeState('v2', a);
    const tip = store.readState()!.sha;
    expect(() => store.writeState('lost', a)).toThrow(/push-failed/);
    expect(store.readState()!.sha).toBe(tip);
    expect(store.readState()!.content).toBe('v2');
  });
  it('two first creators cannot both win (expected-absent lease)', () => {
    const { remote, store } = setup();
    const other = join(mkdtempSync(join(tmpdir(), 'bst2-')), 'w2');
    execFileSync('git', ['init', '-q', other]);
    const store2 = new BranchStore({ repoDir: other, remote });
    store.writeState('A', null);
    expect(() => store2.writeState('B', null)).toThrow(/push-failed/);
    expect(store.readState()!.content).toBe('A');
  });
  it('rejects a malformed expected sha', () => {
    const { store } = setup();
    expect(() => store.writeState('x', 'not-a-sha')).toThrow(/push-failed/);
  });
});

describe('logs branch', () => {
  it('creates the branch and then fast-forwards; only chunk files, fixed message and identity', () => {
    const { remote, store } = setup();
    store.writeLogs([{ path: name('a'), data: Buffer.from('one') }]);
    store.writeLogs([{ path: name('b'), data: Buffer.from('two') }]);
    expect(files(remote, 'logs').sort()).toEqual([name('a'), name('b')]);
    const l = log(remote, 'logs');
    expect(l).toHaveLength(2);
    for (const line of l) expect(line.split('|').slice(0, 5)).toEqual(['fridge-logs', 'fridge-logs@users.noreply.github.com', 'fridge-logs', 'fridge-logs@users.noreply.github.com', 'chunk']);
    expect(sh(remote, 'merge-base', '--is-ancestor', 'logs~1', 'logs')).toBe('');
  });
  it('rejects paths outside chunks/<32 hex>.bin, empty batches and existing paths', () => {
    const { store } = setup();
    for (const p of ['state/oauth.enc.json', '../x.bin', 'chunks/abc.bin', `chunks/${'a'.repeat(32)}.txt`, `chunks/${'A'.repeat(32)}.bin`, `chunks/sub/${'a'.repeat(32)}.bin`]) expect(() => store.writeLogs([{ path: p, data: Buffer.from('x') }])).toThrow(/push-failed/);
    expect(() => store.writeLogs([])).toThrow(/push-failed/);
    store.writeLogs([{ path: name('a'), data: Buffer.from('x') }]);
    expect(() => store.writeLogs([{ path: name('a'), data: Buffer.from('y') }])).toThrow(/push-failed/);
  });
  it('retries on the new tip when another writer pushes first, and keeps both files', () => {
    const { remote, store } = setup();
    store.writeLogs([{ path: name('a'), data: Buffer.from('one') }]);
    const rival = new BranchStore({ repoDir: join(mkdtempSync(join(tmpdir(), 'bst3-')), 'w'), remote });
    execFileSync('git', ['init', '-q', (rival as unknown as { o: { repoDir: string } }).o.repoDir]);
    let once = true;
    const mine = new BranchStore({ repoDir: (store as unknown as { o: { repoDir: string } }).o.repoDir, remote, beforePush: () => { if (once) { once = false; rival.writeLogs([{ path: name('c'), data: Buffer.from('rival') }]); } } });
    mine.writeLogs([{ path: name('b'), data: Buffer.from('mine') }]);
    expect(files(remote, 'logs').sort()).toEqual([name('a'), name('b'), name('c')]);
    expect(log(remote, 'logs')).toHaveLength(3);
  });
  it('gives up after a bounded number of tries', () => {
    const { remote, store } = setup();
    store.writeLogs([{ path: name('a'), data: Buffer.from('one') }]);
    const rivalDir = join(mkdtempSync(join(tmpdir(), 'bst4-')), 'w');
    execFileSync('git', ['init', '-q', rivalDir]);
    const rival = new BranchStore({ repoDir: rivalDir, remote });
    let n = 0;
    const tries: number[] = [];
    const mine = new BranchStore({ repoDir: (store as unknown as { o: { repoDir: string } }).o.repoDir, remote, beforePush: (a) => { tries.push(a); rival.writeLogs([{ path: name(String(n++ % 10)), data: Buffer.from('r') }]); } });
    expect(() => mine.writeLogs([{ path: name('f'), data: Buffer.from('mine') }])).toThrow(/push-failed/);
    expect(tries).toEqual([1, 2, 3, 4, 5]);
    expect(MAX_PUSH_TRIES).toBe(5);
    expect(files(remote, 'logs')).not.toContain(name('f'));
  });
});

describe('quiet and safe', () => {
  it('prints nothing and errors carry only a fixed code (no path, no git text)', () => {
    const spy = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    const { remote, store } = setup('CANARY-secret-remote');
    const a = store.writeState('CANARY-state-content', null);
    let msg = '';
    try { store.writeState('x', '0'.repeat(40)); } catch (e) { msg = String((e as Error).message) + JSON.stringify(e, Object.getOwnPropertyNames(e as object)); }
    store.writeLogs([{ path: name('a'), data: Buffer.from('CANARY-chunk') }]);
    expect(spy).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(msg).toContain('push-failed');
    expect(msg).not.toContain('CANARY');
    expect(msg).not.toContain(remote);
    const bad = new BranchStore({ repoDir: (store as unknown as { o: { repoDir: string } }).o.repoDir, remote: '/nonexistent/CANARY-remote' });
    let m2 = '';
    try { bad.readState(); } catch (e) { m2 = String((e as Error).message); }
    expect(m2).toBe('fetch-failed');
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    spy.mockRestore();
    err.mockRestore();
  });
  it('leaves no stray files in the repo directory working tree', () => {
    const { work, store } = setup();
    store.writeState('x', null);
    store.writeLogs([{ path: name('a'), data: Buffer.from('x') }]);
    expect(sh(work, 'status', '--porcelain')).toBe('');
  });
});

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CodedError } from '../src/record.js';

const priv = (s: BranchStore): { repoDir: string } => (s as unknown as { o: { repoDir: string } }).o;

describe('review hardening', () => {
  it('the auth header never appears in git argv (env config only) nor in errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'shim-'));
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const logf = join(root, 'argv.log');
    const envf = join(root, 'env.log');
    writeFileSync(join(root, 'git'), `#!/bin/sh\necho "$@" >> ${logf}\nenv | grep -c CANARY-HEADER >> ${envf}\nexec ${real} "$@"\n`);
    chmodSync(join(root, 'git'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${root}:${oldPath}`;
    try {
      const { remote, work } = setup();
      const store = new BranchStore({ repoDir: work, remote, extraHeader: 'Authorization: basic CANARY-HEADER' });
      const sha = store.writeState('x', null);
      store.writeState('y', sha);
      store.writeLogs([{ path: name('a'), data: Buffer.from('x') }]);
      const argv = readFileSync(logf, 'utf8');
      expect(argv.length).toBeGreaterThan(50);
      expect(argv).not.toContain('CANARY-HEADER');
      expect(argv).not.toContain('extraheader');
      expect(readFileSync(envf, 'utf8').split('\n').filter(Boolean).some((n) => Number(n) > 0)).toBe(true);
    } finally {
      process.env.PATH = oldPath;
    }
  });
  it('rejects option-like and non-trusted remotes and never runs a helper', () => {
    const { work, root } = setup();
    const marker = join(root, 'pwned');
    const bad = [`--upload-pack=touch ${marker}`, '-x', `ext::sh -c touch% ${marker}`, 'http://example.com/r.git', 'git://example.com/r.git', 'ssh://example.com/r.git', 'file:///tmp/x', 'relative/path', 'https://example.com/../x', 'https://-evil/x', '', ' /tmp/x'];
    for (const remote of bad) expect(() => new BranchStore({ repoDir: work, remote })).toThrow(/bad-remote/);
    for (const h of ['-x', 'a\nb', 'é']) expect(() => new BranchStore({ repoDir: work, remote: '/tmp/ok', extraHeader: h })).toThrow(/bad-remote/);
    expect(existsSync(marker)).toBe(false);
    expect(() => new BranchStore({ repoDir: work, remote: 'https://github.com/reihlinstinct/shabbat-fridge.git' })).not.toThrow();
  });
  it('filesystem failures become a fixed code with no native message or path', () => {
    const { store } = setup();
    const old = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent/CANARY-TMP';
    try {
      let e1: unknown;
      try { store.writeState('x', null); } catch (e) { e1 = e; }
      expect(e1).toBeInstanceOf(CodedError);
      const text = String((e1 as Error).message) + JSON.stringify(e1, Object.getOwnPropertyNames(e1 as object)) + String((e1 as { cause?: unknown }).cause ?? '');
      expect(text).toContain('push-failed');
      expect(text).not.toContain('CANARY');
      expect(text).not.toContain('ENOENT');
      expect((e1 as { cause?: unknown }).cause).toBeUndefined();
      expect(() => store.writeLogs([{ path: name('a'), data: Buffer.from('x') }])).toThrow(/^push-failed$/);
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
  });
  it('a failing operation keeps its own error code (cleanup does not replace it) and leaves no temp dirs', () => {
    const { store } = setup();
    const before = execFileSync('sh', ['-c', `ls ${tmpdir()} | grep -c '^bs-' || true`], { encoding: 'utf8' }).trim();
    expect(() => store.writeState('x', '1'.repeat(40))).toThrow(/^push-failed$/);
    const after = execFileSync('sh', ['-c', `ls ${tmpdir()} | grep -c '^bs-' || true`], { encoding: 'utf8' }).trim();
    expect(after).toBe(before);
  });
  it('rejects duplicate paths in one batch before touching the remote', () => {
    const { remote, store } = setup();
    expect(() => store.writeLogs([{ path: name('a'), data: Buffer.from('one') }, { path: name('a'), data: Buffer.from('two') }])).toThrow(/push-failed/);
    expect(sh(remote, 'branch', '--list')).toBe('');
  });
  it('first logs creation uses an expected-absent lease: a rival that creates it first is merged on the retry, not overwritten', () => {
    const { remote, store } = setup();
    const rivalDir = join(mkdtempSync(join(tmpdir(), 'bst5-')), 'w');
    execFileSync('git', ['init', '-q', rivalDir]);
    const rival = new BranchStore({ repoDir: rivalDir, remote });
    let once = true;
    const mine = new BranchStore({ repoDir: priv(store).repoDir, remote, beforePush: () => { if (once) { once = false; rival.writeLogs([{ path: name('c'), data: Buffer.from('rival') }]); } } });
    mine.writeLogs([{ path: name('b'), data: Buffer.from('mine') }]);
    expect(files(remote, 'logs').sort()).toEqual([name('b'), name('c')]);
    expect(log(remote, 'logs')).toHaveLength(2);
  });
  it('subprocess run with canaries everywhere prints nothing to stdout or stderr', () => {
    const r = spawnSync('npx', ['--no-install', 'tsx', 'test/fixtures/store-run.ts'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
});
