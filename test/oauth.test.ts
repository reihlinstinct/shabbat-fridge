import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPES_INSTALL, authorizeUrl, exchangeCode, refreshState, type OAuthState } from '../src/oauth.js';
import { createOauthApp } from '../src/oauthsetup.js';
import { rotateFile } from '../src/rotatefile.js';
import { SmartThings } from '../src/smartthings.js';
import { newKey, open, seal } from '../src/statecrypt.js';

const STATE: OAuthState = { clientId: 'CID', clientSecret: 'CSECRET', refreshToken: 'RT-1', obtainedAt: '2026-10-28T00:00:00.000Z' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
type Call = { url: string; init?: RequestInit };
const fake = (reply: () => Response, calls: Call[] = []): typeof fetch => (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return reply(); }) as typeof fetch;

describe('oauth client', () => {
  it('authorize URL carries client, scopes, redirect and state', () => {
    const u = new URL(authorizeUrl('CID', 'https://x.example/cb', SCOPES_INSTALL, 'n0nce'));
    expect(u.origin + u.pathname).toBe('https://api.smartthings.com/v1/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('r:locations:* r:devices:* r:rules:* w:rules:*');
    expect(u.searchParams.get('redirect_uri')).toBe('https://x.example/cb');
    expect(u.searchParams.get('state')).toBe('n0nce');
  });
  it('exchange sends Basic auth and a form body', async () => {
    const calls: Call[] = [];
    await exchangeCode('CID', 'CSECRET', 'CODE', 'https://x.example/cb', fake(() => json(200, { access_token: 'A', refresh_token: 'R' }), calls));
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from('CID:CSECRET').toString('base64')}`);
    expect(String(calls[0]!.init!.body)).toContain('grant_type=authorization_code');
    expect(String(calls[0]!.init!.body)).not.toContain('CSECRET');
  });
  it('refresh returns a new state with the NEW refresh token', async () => {
    const r = await refreshState(STATE, fake(() => json(200, { access_token: 'A2', refresh_token: 'RT-2', scope: 's' })), new Date('2026-10-29T00:00:00Z'));
    expect(r.state.refreshToken).toBe('RT-2');
    expect(r.accessToken).toBe('A2');
    expect(r.state.obtainedAt).toBe('2026-10-29T00:00:00.000Z');
  });
  it('failures throw with status and error code only (no body, no secrets)', async () => {
    const bad = fake(() => json(400, { error: 'invalid_grant', error_description: 'refresh RT-1 CSECRET expired' }));
    await expect(refreshState(STATE, bad)).rejects.toThrow('HTTP 400 (invalid_grant)');
    try { await refreshState(STATE, bad); } catch (e) { expect(String(e)).not.toMatch(/RT-1|CSECRET/); }
  });
  it('rejects a response without a new refresh token, or the same one back', async () => {
    await expect(refreshState(STATE, fake(() => json(200, { access_token: 'A' })))).rejects.toThrow(/missing/);
    await expect(refreshState(STATE, fake(() => json(200, { access_token: 'A', refresh_token: 'RT-1' })))).rejects.toThrow(/new refresh token/);
  });
});

describe('sealed state', () => {
  it('round-trips, and the ciphertext does not contain the secrets', () => {
    const k = newKey();
    const s = seal(STATE, k);
    expect(JSON.stringify(s)).not.toMatch(/CSECRET|RT-1|CID/);
    expect(open(s, k)).toEqual(STATE);
  });
  it('wrong key, tampering and a bad key length fail', () => {
    const s = seal(STATE, newKey());
    expect(() => open(s, newKey())).toThrow(/Cannot decrypt/);
    const k = newKey();
    const s2 = seal(STATE, k);
    expect(() => open({ ...s2, ct: Buffer.from('tampered').toString('base64') }, k)).toThrow();
    expect(() => seal(STATE, 'short')).toThrow(/32 bytes/);
  });
  it('each seal uses a fresh IV', () => {
    const k = newKey();
    expect(seal(STATE, k).iv).not.toBe(seal(STATE, k).iv);
  });
});

describe('rotateFile fails closed', () => {
  const setup = (): { file: string; key: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    const key = newKey();
    const file = join(dir, 'oauth.enc.json');
    writeFileSync(file, JSON.stringify(seal(STATE, key)));
    return { file, key };
  };
  it('success replaces the file with the new refresh token', async () => {
    const { file, key } = setup();
    const r = await rotateFile(file, key, fake(() => json(200, { access_token: 'A9', refresh_token: 'RT-9' })));
    expect(r.accessToken).toBe('A9');
    expect(open(JSON.parse(readFileSync(file, 'utf8')), key).refreshToken).toBe('RT-9');
  });
  it('a failed refresh leaves the file byte-for-byte unchanged', async () => {
    const { file, key } = setup();
    const before = readFileSync(file, 'utf8');
    await expect(rotateFile(file, key, fake(() => json(401, { error: 'invalid_grant' })))).rejects.toThrow();
    await expect(rotateFile(file, key, fake(() => json(200, { access_token: 'A' })))).rejects.toThrow();
    await expect(rotateFile(file, newKey(), fake(() => json(200, { access_token: 'A', refresh_token: 'B' })))).rejects.toThrow(/Cannot decrypt/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('a pending state (no authorization yet) is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    const key = newKey();
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify(seal({ ...STATE, refreshToken: 'pending' }, key)));
    await expect(rotateFile(file, key, fake(() => json(200, {})))).rejects.toThrow(/finish the authorization/);
  });
});

describe('createOauthApp', () => {
  const run = (storedScopes: string[], storedRedirect = 'https://x.example/cb'): Promise<unknown> => {
    let n = 0;
    const f = fake(() => {
      n++;
      if (n === 1) return json(200, { app: { appId: 'APP' } });
      if (n === 2) return json(200, { oauthClientId: 'CID', oauthClientSecret: 'CSEC' });
      return json(200, { scope: storedScopes, redirectUris: [storedRedirect] });
    });
    return createOauthApp(new SmartThings('PAT', f), 'n', 'https://x.example/cb', ['r:devices:*', 'r:rules:*']);
  };
  it('returns ids when the stored scopes match', async () => {
    expect(await run(['r:devices:*', 'r:rules:*'])).toMatchObject({ appId: 'APP', clientId: 'CID', clientSecret: 'CSEC' });
  });
  it('detects the known "*" to "$" scope corruption and refuses', async () => {
    await expect(run(['r:devices:$', 'r:devices:*', 'r:rules:*', 'r:rules:$'])).rejects.toThrow(/CLI/);
  });
  it('detects a changed redirect URI', async () => {
    await expect(run(['r:devices:*', 'r:rules:*'], 'https://evil.example/cb')).rejects.toThrow(/redirect/);
  });
});
