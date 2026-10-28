/**
 * Collector token step: refresh the SmartThings OAuth token when needed and write the access token to a 0600 file.
 *   STATE_FILE, STATE_KEY (secret), TOKEN_OUT (file for the access token). Sets the step output rotated=true|false.
 * The token goes to a file, not GITHUB_ENV, so later steps (including the push steps) never have it in their environment.
 * Output is fixed text only; failures print one fixed code.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { isToken } from '../src/oauth.js';
import { rotateFile } from '../src/rotatefile.js';

try {
  const key = process.env.STATE_KEY || '';
  const file = process.env.STATE_FILE || '';
  const out = process.env.TOKEN_OUT || '';
  if (!key || !file || !out) throw new Error('config');
  const { accessToken, rotated } = await rotateFile(file, key);
  if (!isToken(accessToken)) throw new Error('token');
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${accessToken}`);
  writeFileSync(out, accessToken, { mode: 0o600, flag: 'w' });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rotated=${rotated}\n`);
  console.log(rotated ? 'token rotated' : 'token reused');
} catch {
  console.log('rotate failed: oauth-failed');
  process.exit(1);
}
