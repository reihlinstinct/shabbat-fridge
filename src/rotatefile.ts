import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { refreshState } from './oauth.js';
import { open, seal, type Sealed } from './statecrypt.js';
import type { Fetch } from './smartthings.js';

/**
 * Refresh and store the new sealed state. Fails closed: the file is replaced only after a successful refresh
 * and a successful read-back of the new sealed value; any earlier failure throws and leaves the file untouched.
 */
export async function rotateFile(file: string, key: string, fetcher: Fetch = fetch, now = new Date()): Promise<{ accessToken: string; obtainedAt: string }> {
  const old = open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, key);
  if (old.refreshToken === 'pending') throw new Error('No refresh token stored yet: finish the authorization (oauth-setup exchange) first');
  const { state, accessToken } = await refreshState(old, fetcher, now);
  const next = seal(state, key);
  if (open(next, key).refreshToken !== state.refreshToken) throw new Error('internal check failed: sealed state does not round-trip');
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 1) + '\n');
  renameSync(`${file}.tmp`, file);
  return { accessToken, obtainedAt: state.obtainedAt };
}
