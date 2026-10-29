import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPES_INSTALL, authorizeUrl, exchangeCode, refreshState, type OAuthState } from '../src/oauth.js';
import { createOauthApp } from '../src/oauthsetup.js';
import { rotateFile } from '../src/rotatefile.js';
import { SmartThings } from '../src/smartthings.js';
import { isToken } from '../src/oauth.js';
import { newKey, open, seal } from '../src/statecrypt.js';

const STATE: OAuthState = { clientId: 'CID', clientSecret: 'CSECRET', refreshToken: 'RT-1', obtainedAt: '2026-10-28T00:00:00.000Z' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
type Call = { url: string; init?: RequestInit };
const fake = (reply: () => Response, calls: Call[] = []): typeof fetch => (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return reply(); }) as typeof fetch;

describe('oauth client', () => {
  it('authorize URL carries client, scopes, redirect and state', () => {
    const u = new URL(authorizeUrl('CID', 'https://x.example/cb', SCOPES_INSTALL, 'n0nce'));
    expect(u.origin + u.pathname).toBe('https://api.smartthings.com/oauth/authorize');
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

describe('access token reuse', () => {
  it('a still-valid stored access token is reused: no network call, file unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    const key = newKey();
    const file = join(dir, 's.json');
    const now = new Date('2026-10-28T12:00:00Z');
    writeFileSync(file, JSON.stringify(seal({ ...STATE, accessToken: 'AT', accessExpiresAt: new Date(now.getTime() + 5 * 3600000).toISOString() }, key)));
    const before = readFileSync(file, 'utf8');
    const calls: Call[] = [];
    const r = await rotateFile(file, key, fake(() => json(500, {}), calls), now);
    expect(r).toMatchObject({ accessToken: 'AT', rotated: false });
    expect(calls).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('an access token with under 2 hours left triggers a refresh and stores the new token and expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    const key = newKey();
    const file = join(dir, 's.json');
    const now = new Date('2026-10-28T12:00:00Z');
    writeFileSync(file, JSON.stringify(seal({ ...STATE, accessToken: 'AT', accessExpiresAt: new Date(now.getTime() + 3600000).toISOString() }, key)));
    const r = await rotateFile(file, key, fake(() => json(200, { access_token: 'AT2', refresh_token: 'RT-2', expires_in: 86000 })), now);
    expect(r.rotated).toBe(true);
    const s = open(JSON.parse(readFileSync(file, 'utf8')), key);
    expect(s).toMatchObject({ refreshToken: 'RT-2', accessToken: 'AT2' });
    expect(Date.parse(s.accessExpiresAt!)).toBeGreaterThan(now.getTime() + 20 * 3600000);
  });
});

describe('malformed token responses never replace good state', () => {
  const bad: Array<[string, unknown]> = [
    ['numbers instead of strings', { access_token: 42, refresh_token: 99 }],
    ['empty strings', { access_token: '', refresh_token: '' }],
    ['newline in the access token', { access_token: 'A\nEVIL=1', refresh_token: 'R2' }],
    ['carriage return in the refresh token', { access_token: 'A', refresh_token: 'R\r2' }],
    ['space in a token', { access_token: 'A B', refresh_token: 'R2' }],
    ['array body', [1, 2]],
    ['null body', null],
    ['negative expires_in', { access_token: 'A', refresh_token: 'R2', expires_in: -5 }],
    ['string expires_in', { access_token: 'A', refresh_token: 'R2', expires_in: '86000' }],
    ['non-string scope', { access_token: 'A', refresh_token: 'R2', scope: 5 }],
  ];
  for (const [name, body] of bad) {
    it(`${name}: rotateFile throws and the file is byte-identical`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rot-'));
      const key = newKey();
      const file = join(dir, 's.json');
      writeFileSync(file, JSON.stringify(seal(STATE, key)));
      const before = readFileSync(file, 'utf8');
      await expect(rotateFile(file, key, fake(() => json(200, body)))).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(before);
    });
  }
  it('isToken accepts normal tokens only', () => {
    expect(isToken('68e5657b-2892-4aa2-902b-3461116e6ea6')).toBe(true);
    for (const v of ['', ' ', 'a b', 'a\nb', 7, null, undefined, 'x'.repeat(5000)]) expect(isToken(v)).toBe(false);
  });
  it('a state file with non-string fields is rejected on open', () => {
    const k = newKey();
    const s = seal({ ...STATE, refreshToken: 99 as unknown as string }, k);
    expect(() => open(s, k)).toThrow(/malformed/);
  });
});

describe('persisted read-back before the atomic rename', () => {
  const setup = (): { file: string; key: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    const key = newKey();
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify(seal(STATE, key)));
    return { file, key };
  };
  const ok = fake(() => json(200, { access_token: 'A9', refresh_token: 'RT-9' }));
  it('a corrupted write is detected and the good file stays', async () => {
    const { file, key } = setup();
    const before = readFileSync(file, 'utf8');
    await expect(rotateFile(file, key, ok, new Date(), 7200000, (p, d) => writeFileSync(p, d.slice(0, 40)))).rejects.toThrow(/read back/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('a write that decrypts but holds different data is detected', async () => {
    const { file, key } = setup();
    const before = readFileSync(file, 'utf8');
    const other = JSON.stringify(seal({ ...STATE, refreshToken: 'WRONG' }, key));
    await expect(rotateFile(file, key, ok, new Date(), 7200000, (p) => writeFileSync(p, other))).rejects.toThrow(/differs/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('cached state validation', () => {
  const write = (st: Partial<OAuthState>) => {
    const key = newKey();
    const file = join(mkdtempSync(join(tmpdir(), 'cs-')), 's.json');
    writeFileSync(file, JSON.stringify(seal({ ...STATE, ...st } as OAuthState, key)));
    return { key, file };
  };
  const future = new Date(Date.now() + 20 * 3600 * 1000).toISOString();
  for (const bad of ['CACHE\nINJECTED=1', 'a b', 'x\r\ny', '']) {
    it(`rejects a cached accessToken ${JSON.stringify(bad)} without exporting it`, async () => {
      const { key, file } = write({ accessToken: bad, accessExpiresAt: future });
      await expect(rotateFile(file, key)).rejects.toThrow(/incomplete or malformed/);
    });
    it(`rejects a stored refreshToken ${JSON.stringify(bad)}`, () => {
      const { key, file } = write({ refreshToken: bad });
      expect(() => open(JSON.parse(readFileSync(file, 'utf8')), key)).toThrow(/malformed/);
    });
  }
  it('still accepts the setup "pending" sentinel', () => {
    const { key, file } = write({ refreshToken: 'pending' });
    expect(open(JSON.parse(readFileSync(file, 'utf8')), key).refreshToken).toBe('pending');
  });
});

describe('oauth-setup output (CodeQL js/clear-text-logging, issue #67)', () => {
  it('create-app notice is fixed text and carries no identifiers', async () => {
    const { createAppNotice } = await import('../src/oauthsetup.js');
    const out = createAppNotice('state/oauth.enc.json');
    expect(out).toBe('App created. Sealed state written to state/oauth.enc.json. Next: authorize-url.');
    expect(out).not.toMatch(/client|secret|appId|\bid\b/i);
  });
  it('the script prints no app id, client id or secret in any console call', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 'oauth-setup.ts'), 'utf8');
    const logs = src.split('\n').filter((l) => /console\.(log|error|warn|info)/.test(l));
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/app\.(appId|clientId|clientSecret)|st\.clientSecret|clientSecret|refreshToken|STATE_KEY|ST_PAT/);
    // the only value allowed to reach a console call that contains a client id is the authorization URL the user must open
    expect(logs.filter((l) => /clientId/.test(l))).toEqual(["  console.log(authorizeUrl(st.clientId, redirect, scopes, nonce));"]);
  });
});
