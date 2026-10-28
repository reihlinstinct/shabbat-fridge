import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { open, seal, type Sealed } from './statecrypt.js';

/** Read the stored cursor (undefined for an old-format state). */
export const readCursor = (file: string, key: string): string | undefined => open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, key).eventCursor;

/**
 * Re-seal the state with the cursor (kept as is when `cursor` is undefined) and replace the file after a read-back check.
 * It always writes a new ciphertext, even when nothing changed: `seal` uses a fresh random nonce, so the file differs on every call.
 */
export function applyCursor(file: string, key: string, cursor: string | undefined, write: (path: string, data: string) => void = writeFileSync): void {
  const old = open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, key);
  // Monotonic: a cursor older than the stored one is ignored.
  const keep = cursor === undefined || (old.eventCursor !== undefined && Date.parse(cursor) < Date.parse(old.eventCursor));
  const next = keep ? old : { ...old, eventCursor: cursor };
  const tmp = `${file}.tmp`;
  try {
    write(tmp, JSON.stringify(seal(next, key), null, 1) + '\n');
    let back;
    try {
      back = open(JSON.parse(readFileSync(tmp, 'utf8')) as Sealed, key);
    } catch {
      throw new Error('internal check failed: the written state cannot be read back; the previous state file is untouched');
    }
    if (!isDeepStrictEqual(back, JSON.parse(JSON.stringify(next)))) throw new Error('internal check failed: the written state differs from the new state; the previous state file is untouched');
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
