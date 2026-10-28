import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { refreshState } from './oauth.js';
import { open, seal, type Sealed } from './statecrypt.js';
import type { Fetch } from './smartthings.js';

/**
 * Refresh and store the new sealed state. Fails closed: the file is replaced only after a successful refresh
 * and a successful read-back of the new sealed value; any earlier failure throws and leaves the file untouched.
 */
export async function rotateFile(file: string, key: string, fetcher: Fetch = fetch, now = new Date(), minValidMs = 2 * 3600 * 1000, write: (path: string, data: string) => void = writeFileSync): Promise<{ accessToken: string; obtainedAt: string; rotated: boolean }> {
  const old = open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, key);
  // Reuse a stored access token while it has more than minValidMs left: no refresh, no new refresh token, no file change.
  if (old.accessToken && old.accessExpiresAt && Date.parse(old.accessExpiresAt) - now.getTime() > minValidMs) {
    return { accessToken: old.accessToken, obtainedAt: old.obtainedAt, rotated: false };
  }
  if (old.refreshToken === 'pending') throw new Error('No refresh token stored yet: finish the authorization (oauth-setup exchange) first');
  const { state, accessToken } = await refreshState(old, fetcher, now);
  const next = seal(state, key);
  const tmp = `${file}.tmp`;
  write(tmp, JSON.stringify(next, null, 1) + '\n');
  // Read the temp file back from disk and compare every field before it replaces the good file.
  let back;
  try {
    back = open(JSON.parse(readFileSync(tmp, 'utf8')) as Sealed, key);
  } catch {
    throw new Error('internal check failed: the written state cannot be read back; the previous state file is untouched');
  }
  if (!isDeepStrictEqual(back, JSON.parse(JSON.stringify(state)))) throw new Error('internal check failed: the written state differs from the new state; the previous state file is untouched');
  renameSync(tmp, file);
  return { accessToken, obtainedAt: state.obtainedAt, rotated: true };
}
