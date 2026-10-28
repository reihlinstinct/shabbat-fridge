import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORD_CONTEXT } from '../src/collectrun.js';
import { randomBytes } from 'node:crypto';
import { decryptDir, isCanonicalTime, writeLayout } from '../src/decryptlogs.js';
import { chunkFileName, encryptLog, generateKeyPair } from '../src/logcrypt.js';
import { gzipSync } from 'node:zlib';

const ROOT = resolve('.');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const keys = generateKeyPair();
const other = generateKeyPair();
const rec = (takenAt: string, events: Array<{ k: string; time: string }>) => ({ v: 1, takenAt, place: { latitude: 1, longitude: 2, tzid: 'Asia/Jerusalem' }, sabbath: null, rules: [], events });
const seal = (r: unknown, pub = keys.publicKey) => encryptLog(gzipSync(Buffer.from(JSON.stringify(r))), pub, RECORD_CONTEXT)[0]!;

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const logs = join(root, 'logs');
  mkdirSync(join(logs, 'chunks'), { recursive: true });
  const put = (b: Buffer, name = chunkFileName()) => writeFileSync(join(logs, 'chunks', name), b);
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, keys.privateKey + '\n', { mode: 0o600 });
  return { root, logs, put, keyFile, out: join(root, 'out') };
}
const run = (args: string[], env: Record<string, string>) =>
  spawnSync(TSX, [join(ROOT, 'scripts/decrypt-logs.ts'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

describe('decryptDir', () => {
  it('round trips and sorts by takenAt', () => {
    const t = tree();
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [{ k: 'a', time: '2026-10-28T09:00:00Z' }])));
    t.put(seal(rec('2026-10-28T09:00:00.000Z', [])));
    const r = decryptDir(t.logs, keys.privateKey);
    expect(r.failed).toBe(0);
    expect(r.records.map((x) => x.takenAt)).toEqual(['2026-10-28T09:00:00.000Z', '2026-10-28T10:00:00.000Z']);
  });
  it('counts tampered, truncated, unknown-version, foreign-key and badly named chunks as failures', () => {
    const t = tree();
    const good = seal(rec('2026-10-28T10:00:00.000Z', []));
    t.put(good);
    const bad = Buffer.from(good); bad[bad.length - 1]! ^= 1; t.put(bad);
    t.put(good.subarray(0, 100));
    const v = Buffer.from(good); v[0] = 9; t.put(v);
    t.put(seal(rec('2026-10-28T11:00:00.000Z', []), other.publicKey));
    t.put(good, 'notahexname.bin');
    const r = decryptDir(t.logs, keys.privateKey);
    expect(r.records).toHaveLength(1);
    expect(r.failed).toBe(5);
  });
  it('counts a chunk whose content is not a valid record as a failure', () => {
    const t = tree();
    t.put(seal({ hello: 'world' }));
    expect(decryptDir(t.logs, keys.privateKey).failed).toBe(1);
  });
});

describe('decryptDir hardening', () => {
  it('rejects non-canonical takenAt, including path-like text, as a failed chunk', () => {
    const t = tree();
    for (const bad of ['../../2026-10-28', '2026-10-28', '2026-10-28T10:00:00Z', '2026-10-28T10:00:00.000+02:00', '2026-13-45T10:00:00.000Z', '']) t.put(seal(rec(bad, [])));
    const r = decryptDir(t.logs, keys.privateKey);
    expect(r.records).toHaveLength(0);
    expect(r.failed).toBe(6);
    expect(isCanonicalTime('2026-10-28T10:00:00.000Z')).toBe(true);
  });
  it('fails a chunk whose events are missing k, have a non-string k, or an unparseable time', () => {
    const t = tree();
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [{ time: '2026-10-28T09:00:00Z' } as never])));
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [{ k: 5, time: '2026-10-28T09:00:00Z' } as never])));
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [{ k: 'a', time: '../x' }])));
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [null as never])));
    const r = decryptDir(t.logs, keys.privateKey);
    expect(r.failed).toBe(4);
    expect(r.records).toHaveLength(0);
  });
  it('writeLayout never writes outside OUT_DIR even when handed a hostile record', () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-'));
    const out = join(root, 'out');
    mkdirSync(out);
    expect(() => writeLayout(out, [rec('../../x', [])] as never)).toThrow();
    expect(() => writeLayout(out, [rec('2026-10-28T10:00:00.000Z', [{ k: 'a', time: '../../q' }])] as never)).toThrow();
    expect(readdirSync(root)).toEqual(['out']);
  });
  it('reassembles a record that spans several chunks', () => {
    const t = tree();
    const events = Array.from({ length: 1500 }, (_, i) => ({ k: randomBytes(12).toString('hex') + i, time: '2026-10-28T09:00:00Z' }));
    const chunks = encryptLog(gzipSync(Buffer.from(JSON.stringify(rec('2026-10-28T10:00:00.000Z', events)))), keys.publicKey, RECORD_CONTEXT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) t.put(c);
    const r = decryptDir(t.logs, keys.privateKey);
    expect(r.failed).toBe(0);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.events).toHaveLength(1500);
    t.put(Buffer.from('x'));
    expect(decryptDir(t.logs, keys.privateKey).failed).toBe(1);
  });
  it('fails loudly when the chunks directory is empty, and chmods an existing empty OUT_DIR to 0700', () => {
    const t = tree();
    const r = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: t.out, LOGS_PRIVATE_KEY_FILE: t.keyFile });
    expect(r.stdout.trim()).toBe('decrypt-logs failed: no-chunks');
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [])));
    mkdirSync(join(t.root, 'wide'), { mode: 0o755 });
    chmodSync(join(t.root, 'wide'), 0o755);
    const ok = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: join(t.root, 'wide'), LOGS_PRIVATE_KEY_FILE: t.keyFile });
    expect(ok.status).toBe(0);
    expect(statSync(join(t.root, 'wide')).mode & 0o777).toBe(0o700);
  });
});

describe('scripts/decrypt-logs.ts', () => {
  it('writes the analyzer layout, dedupes events, prints counts only, and never prints canaries or the key', () => {
    const t = tree();
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [{ k: 'a', time: '2026-10-28T09:00:00Z' }, { k: 'CANARY-EVENT', time: '2026-11-01T09:00:00Z' }])));
    t.put(seal(rec('2026-10-28T11:00:00.000Z', [{ k: 'a', time: '2026-10-28T09:00:00Z' }])));
    const r = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: t.out, LOGS_PRIVATE_KEY_FILE: t.keyFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^chunks 2, failed 0, snapshots 2, events 2, hours since newest chunk [\d.]+\n$/);
    expect(r.stdout + r.stderr).not.toContain('CANARY');
    expect(r.stdout + r.stderr).not.toContain(keys.privateKey);
    expect(readdirSync(join(t.out, 'snapshots/2026-10')).length).toBe(2);
    expect(readFileSync(join(t.out, 'events/2026-10.ndjson'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(t.out, 'events/2026-11.ndjson'), 'utf8')).toContain('CANARY-EVENT');
    expect(statSync(t.out).mode & 0o777).toBe(0o700);
  });
  it('exits non-zero when any chunk fails but still reports the counts', () => {
    const t = tree();
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [])));
    t.put(Buffer.from('junk'));
    const r = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: t.out, LOGS_PRIVATE_KEY_FILE: t.keyFile });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('failed 1');
  });
  const refused = (code: string, env: (t: ReturnType<typeof tree>) => Record<string, string>, setup?: (t: ReturnType<typeof tree>) => void) => {
    const t = tree();
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [])));
    setup?.(t);
    const r = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: t.out, LOGS_PRIVATE_KEY_FILE: t.keyFile, ...env(t) });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe(`decrypt-logs failed: ${code}`);
    expect(r.stdout + r.stderr).not.toContain(keys.privateKey);
    return t;
  };
  it('refuses under CI and GITHUB_ACTIONS before reading anything', () => {
    refused('refused-ci', () => ({ CI: 'true' }));
    refused('refused-ci', () => ({ GITHUB_ACTIONS: 'true' }));
  });
  it('refuses a key file that is a symlink, has a wide mode, or sits inside a worktree', () => {
    refused('key-file-not-regular', (t) => ({ LOGS_PRIVATE_KEY_FILE: join(t.root, 'link') }), (t) => symlinkSync(t.keyFile, join(t.root, 'link')));
    refused('key-file-mode', () => ({}), (t) => chmodSync(t.keyFile, 0o640));
    refused('key-file-in-worktree', (t) => ({ LOGS_PRIVATE_KEY_FILE: join(t.root, 'repo/key') }), (t) => {
      mkdirSync(join(t.root, 'repo'));
      execFileSync('git', ['init', '-q', join(t.root, 'repo')]);
      writeFileSync(join(t.root, 'repo/key'), keys.privateKey, { mode: 0o600 });
    });
  });
  it('refuses OUT_DIR inside a worktree (directory or file .git, nested), inside LOGS_DIR, or not empty', () => {
    refused('out-in-worktree', (t) => ({ OUT_DIR: join(t.root, 'repo/a/b') }), (t) => {
      mkdirSync(join(t.root, 'repo'));
      execFileSync('git', ['init', '-q', join(t.root, 'repo')]);
    });
    refused('out-in-worktree', (t) => ({ OUT_DIR: join(t.root, 'wt/x') }), (t) => {
      mkdirSync(join(t.root, 'wt'));
      writeFileSync(join(t.root, 'wt/.git'), 'gitdir: /nowhere\n');
    });
    refused('out-in-logs-dir', (t) => ({ OUT_DIR: join(t.logs, 'sub') }));
    const t = refused('out-not-empty', (t) => ({ OUT_DIR: join(t.root, 'full') }), (t) => {
      mkdirSync(join(t.root, 'full'));
      writeFileSync(join(t.root, 'full/x'), '1');
    });
    expect(existsSync(join(t.root, 'full/snapshots'))).toBe(false);
  });
  it('keygen writes a new 0600 key file, prints only the public key, and refuses to overwrite or to write in a worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'kg-'));
    const f = join(root, 'k');
    const r = run(['keygen'], { LOGS_PRIVATE_KEY_FILE: f });
    expect(r.status).toBe(0);
    const priv = readFileSync(f, 'utf8').trim();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain(priv);
    expect(r.stdout).toMatch(/public key \(goes to config\/logs\.pub\): [A-Za-z0-9+/=]{44}\n$/);
    expect(run(['keygen'], { LOGS_PRIVATE_KEY_FILE: f }).status).toBe(1);
    expect(readFileSync(f, 'utf8').trim()).toBe(priv);
    mkdirSync(join(root, 'repo'));
    execFileSync('git', ['init', '-q', join(root, 'repo')]);
    const w = run(['keygen'], { LOGS_PRIVATE_KEY_FILE: join(root, 'repo/k') });
    expect(w.stdout.trim()).toBe('decrypt-logs failed: key-file-in-worktree');
    expect(existsSync(join(root, 'repo/k'))).toBe(false);
  });
  it('resolves symlinked parents: keygen and OUT_DIR through an outside alias into a worktree are refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'sl-'));
    mkdirSync(join(root, 'repo/sub'), { recursive: true });
    execFileSync('git', ['init', '-q', join(root, 'repo')]);
    symlinkSync(join(root, 'repo/sub'), join(root, 'alias'));
    const w = run(['keygen'], { LOGS_PRIVATE_KEY_FILE: join(root, 'alias/private') });
    expect(w.stdout.trim()).toBe('decrypt-logs failed: key-file-in-worktree');
    expect(existsSync(join(root, 'repo/sub/private'))).toBe(false);
    const w2 = run(['keygen'], { LOGS_PRIVATE_KEY_FILE: join(root, 'alias/new/private') });
    expect(w2.stdout.trim()).toBe('decrypt-logs failed: key-file-in-worktree');
    const t = tree();
    t.put(seal(rec('2026-10-28T10:00:00.000Z', [])));
    const r = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: join(root, 'alias/out'), LOGS_PRIVATE_KEY_FILE: t.keyFile });
    expect(r.stdout.trim()).toBe('decrypt-logs failed: out-in-worktree');
    expect(existsSync(join(root, 'repo/sub/out'))).toBe(false);
    // a symlinked key file parent that points into a worktree is refused for decrypt too
    symlinkSync(join(root, 'repo/sub'), join(root, 'alias2'));
    writeFileSync(join(root, 'repo/sub/key'), keys.privateKey, { mode: 0o600 });
    const k = run(['decrypt'], { LOGS_DIR: t.logs, OUT_DIR: t.out, LOGS_PRIVATE_KEY_FILE: join(root, 'alias2/key') });
    expect(k.stdout.trim()).toBe('decrypt-logs failed: key-file-in-worktree');
    // LOGS_DIR reached through a symlink: OUT_DIR inside the real LOGS_DIR is still refused
    symlinkSync(t.logs, join(root, 'logalias'));
    const l = run(['decrypt'], { LOGS_DIR: join(root, 'logalias'), OUT_DIR: join(t.logs, 'o'), LOGS_PRIVATE_KEY_FILE: t.keyFile });
    expect(l.stdout.trim()).toBe('decrypt-logs failed: out-in-logs-dir');
  });
});
