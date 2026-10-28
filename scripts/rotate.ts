/**
 * Refresh the SmartThings OAuth token and store the NEW refresh token (single-use) back, encrypted.
 *   STATE_FILE (default state/oauth.enc.json), STATE_KEY (secret).
 * Fails closed: any failure leaves the state file untouched. On success it masks the access token and exports it as
 * ST_TOKEN for later steps (GITHUB_ENV).
 */
import { appendFileSync } from 'node:fs';
import { rotateFile } from '../src/rotatefile.js';

const key = process.env.STATE_KEY || '';
if (!key) throw new Error('missing STATE_KEY');
const { accessToken, obtainedAt, rotated } = await rotateFile(process.env.STATE_FILE || 'state/oauth.enc.json', key);
if (process.env.GITHUB_ENV) {
  console.log(`::add-mask::${accessToken}`);
  appendFileSync(process.env.GITHUB_ENV, `ST_TOKEN=${accessToken}\n`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rotated=${rotated}\n`);
console.log(rotated ? `Token rotated at ${obtainedAt}. New sealed state written.` : `Stored access token still valid (from ${obtainedAt}); nothing rotated.`);
