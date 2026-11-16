/**
 * Apply the cursor hand-off written by collect-encrypted.ts: re-seal the OAuth state (fresh nonce, so the file always changes).
 *   STATE_FILE, STATE_KEY, CURSOR_OUT. Fixed-text output only.
 */
import { readFileSync } from 'node:fs';
import { applyCursor } from '../src/cursorfile.js';

try {
  const { cursor } = JSON.parse(readFileSync(process.env.CURSOR_OUT || '', 'utf8')) as { cursor: string | null };
  applyCursor(process.env.STATE_FILE || '', process.env.STATE_KEY || '', cursor ?? undefined);
  console.log('state sealed');
} catch {
  console.log('apply-cursor failed');
  process.exit(1);
}
