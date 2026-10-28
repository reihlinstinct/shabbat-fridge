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
