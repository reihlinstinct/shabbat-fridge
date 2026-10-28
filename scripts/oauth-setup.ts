/**
 * One-time setup of the unattended SmartThings token. Run it where the sealed state file will live (the PRIVATE repo checkout).
 *   create-app   ST_PAT (token with app scopes), STATE_KEY, STATE_FILE, REDIRECT_URI, SCOPES=read|install, APP_NAME
 *   authorize-url STATE_KEY, STATE_FILE, REDIRECT_URI, SCOPES  -> prints the URL to open once (prints no secret)
 *   exchange     STATE_KEY, STATE_FILE, REDIRECT_URI, CODE      -> stores the refresh token (sealed)
 * Secrets are never printed. The client secret and refresh token exist only inside the sealed file.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCOPES_INSTALL, SCOPES_READ, authorizeUrl, exchangeCode } from '../src/oauth.js';
import { createOauthApp } from '../src/oauthsetup.js';
import { open, seal, type Sealed } from '../src/statecrypt.js';
import { SmartThings } from '../src/smartthings.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const need = (k: string): string => env(k) || (() => { throw new Error(`missing ${k}`); })();
const file = env('STATE_FILE', 'state/oauth.enc.json');
const key = need('STATE_KEY');
const redirect = need('REDIRECT_URI');
const scopes = env('SCOPES', 'read') === 'install' ? SCOPES_INSTALL : SCOPES_READ;
const cmd = process.argv[2];
const save = (state: Parameters<typeof seal>[0]): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(seal(state, key), null, 1) + '\n');
};

if (cmd === 'create-app') {
  if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite`);
  const app = await createOauthApp(new SmartThings(need('ST_PAT')), env('APP_NAME', 'shabbat-fridge'), redirect, scopes);
  save({ clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: 'pending', obtainedAt: new Date().toISOString(), scope: app.scopes.join(' ') });
  console.log(`App created (id ${app.appId}, client id ${app.clientId}). Sealed state written to ${file}. Next: authorize-url.`);
} else if (cmd === 'authorize-url') {
  const st = open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, key);
  const nonce = randomBytes(16).toString('hex');
  console.log(authorizeUrl(st.clientId, redirect, scopes, nonce));
} else if (cmd === 'exchange') {
  const st = open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, key);
  const t = await exchangeCode(st.clientId, st.clientSecret, need('CODE'), redirect);
  save({ ...st, refreshToken: t.refresh_token, obtainedAt: new Date().toISOString(), scope: t.scope ?? st.scope });
  console.log('Authorization stored (sealed). Run the rotate workflow to confirm.');
} else {
  throw new Error('usage: oauth-setup.ts create-app | authorize-url | exchange');
}
