import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newKey, open, seal, type Sealed } from '../src/statecrypt.js';
import { reseal } from '../src/reseal.js';

const state = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken', obtainedAt: '2026-10-28T10:00:00Z' };
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reseal-'));
  file = join(dir, 'oauth.enc.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reseal', () => {
  it('moves the state to the new key: the old key no longer opens it and the content is unchanged', () => {
    const a = newKey();
    const b = newKey();
    writeFileSync(file, JSON.stringify(seal(state, a)));
    reseal(file, a, b);
    const sealed = JSON.parse(readFileSync(file, 'utf8')) as Sealed;
    expect(open(sealed, b)).toEqual(state);
    expect(() => open(sealed, a)).toThrow();
    expect(readdirSync(dir)).toEqual(['oauth.enc.json']);
  });
  it('leaves the file untouched with a wrong old key or an identical new key', () => {
    const a = newKey();
    writeFileSync(file, JSON.stringify(seal(state, a)));
    const before = readFileSync(file, 'utf8');
    expect(() => reseal(file, newKey(), newKey())).toThrow();
    expect(() => reseal(file, a, a)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['oauth.enc.json']);
  });
  it('script prints fixed text only, also on failure, and never the keys', () => {
    const a = newKey();
    const b = newKey();
    writeFileSync(file, JSON.stringify(seal(state, a)));
    const run = (o: string) => spawnSync('npx', ['--no-install', 'tsx', 'scripts/reseal-state.ts'], { encoding: 'utf8', env: { ...process.env, STATE_FILE: file, OLD_STATE_KEY: o, NEW_STATE_KEY: b } });
    const bad = run(newKey());
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toBe('reseal failed\n');
    const ok = run(a);
    expect(ok.status).toBe(0);
    expect(ok.stdout + ok.stderr).toBe('state re-sealed\n');
    expect(ok.stdout + ok.stderr).not.toContain(a);
    expect(ok.stdout + ok.stderr).not.toContain(b);
  });
});
