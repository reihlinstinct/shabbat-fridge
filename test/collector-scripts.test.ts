import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BranchStore } from '../src/branchstore.js';

const ROOT = resolve('.');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const run = (script: string, cmd: string[], cwd: string, env: Record<string, string>) =>
  spawnSync(TSX, [join(ROOT, 'scripts', script), ...cmd], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env } });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const remote = join(root, 'CANARY-remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', work]);
  return { root, remote, work };
}

describe('scripts/store.ts (subprocess)', () => {
  it('writes state, reads it back and writes logs, printing fixed text only', () => {
    const { root, remote, work } = setup();
    const stateFile = join(root, 'tmp/state/oauth.enc.json');
    const shaFile = join(root, 'tmp/state.sha');
    mkdirSync(join(root, 'tmp/state'), { recursive: true });
    writeFileSync(stateFile, 'CANARY-STATE');
    const env = { STORE_REMOTE: remote, STATE_FILE: stateFile, STATE_SHA_FILE: shaFile };
    // absent state: read fails closed with a fixed code
    let r = run('store.ts', ['read-state'], work, env);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('store failed: state-missing');
    writeFileSync(shaFile, new BranchStore({ repoDir: work, remote }).writeState('CANARY-OLD', null));
    r = run('store.ts', ['write-state'], work, env);
    expect(r.stdout.trim()).toBe('state written');
    expect(r.status).toBe(0);
    r = run('store.ts', ['read-state'], work, { ...env, STATE_FILE: join(root, 'tmp/out/oauth.enc.json') });
    expect(r.stdout.trim()).toBe('state read');
    const out = join(root, 'tmp/out/oauth.enc.json');
    expect(readFileSync(out, 'utf8')).toBe('CANARY-STATE');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const chunks = join(root, 'chunks-dir/chunks');
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(chunks, `${'a'.repeat(32)}.bin`), 'CANARY-CHUNK');
    r = run('store.ts', ['write-logs'], work, { ...env, CHUNK_DIR: join(root, 'chunks-dir') });
    expect(r.stdout.trim()).toBe('logs written');
    expect(execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'logs'], { encoding: 'utf8' }).trim()).toBe(`chunks/${'a'.repeat(32)}.bin`);
  });
  it('rejects an unknown command and a missing variable with fixed codes and never echoes the token or remote', () => {
    const { remote, work } = setup();
    const env = { STORE_REMOTE: remote, GH_TOKEN: 'CANARY-TOKEN' };
    let r = run('store.ts', ['nope'], work, env);
    expect(r.stdout.trim()).toBe('store failed: bad-command');
    r = run('store.ts', ['read-state'], work, env);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toMatch(/CANARY/);
  });
  it('ignores STORE_REMOTE inside GitHub Actions: it targets the real repository URL, never the override', () => {
    const { remote, work } = setup();
    const r = run('store.ts', ['bad'], work, { STORE_REMOTE: remote, GITHUB_ACTIONS: 'true', GH_TOKEN: 'CANARY-TOKEN' });
    expect(r.stdout).toContain('::add-mask::');
    expect(r.stdout).not.toContain('CANARY-TOKEN');
    expect(r.stdout).toContain('store failed: bad-command');
  });
});

describe('scripts/collector-rotate.ts (subprocess)', () => {
  it('fails with one fixed code, writes no token file and leaks nothing when config is missing or the state is bad', () => {
    const { root, work } = setup();
    const out = join(root, 'tok');
    const bad = join(root, 'bad.json');
    writeFileSync(bad, 'CANARY-NOT-JSON');
    for (const env of [{} as Record<string, string>, { STATE_KEY: 'CANARY-KEY', STATE_FILE: bad, TOKEN_OUT: out }]) {
      const r = run('collector-rotate.ts', [], work, env);
      expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe('rotate failed: oauth-failed');
      expect(r.stdout + r.stderr).not.toMatch(/CANARY/);
      expect(existsSync(out)).toBe(false);
    }
  });
});
