import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { open, seal, type Sealed } from './statecrypt.js';

/**
 * Re-seal the OAuth state under a new key (STATE_KEY rotation). The old file is replaced only after the new one reads back
 * with the new key to the same state. Keys come from the caller (environment), never from arguments; nothing is printed.
 */
export function reseal(file: string, oldKey: string, newKey: string): void {
  if (oldKey.trim() === newKey.trim()) throw new Error('the new key must differ from the old key');
  const state = open(JSON.parse(readFileSync(file, 'utf8')) as Sealed, oldKey);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(seal(state, newKey), null, 1) + '\n', { mode: 0o600 });
    if (!isDeepStrictEqual(open(JSON.parse(readFileSync(tmp, 'utf8')) as Sealed, newKey), state)) throw new Error('internal check failed: the re-sealed state differs; the previous file is untouched');
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
