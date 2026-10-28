/**
 * Encrypted collector run (read-only against SmartThings). Writes ONE fixed-size encrypted chunk and a cursor hand-off file.
 *   ST_TOKEN or ST_TOKEN_FILE, STATE_FILE + STATE_KEY (read the cursor only), LOGS_PUBLIC_KEY_FILE (default config/logs.pub),
 *   CHUNK_DIR (where chunks/<random>.bin goes), CURSOR_OUT (temp file for the next cursor; apply it with apply-cursor.ts after the chunk is pushed).
 * Output is fixed text only. It never prints counts, ids, times or data, and errors print only a fixed code (the run log is public).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectOnce } from '../src/collectrun.js';
import { readCursor } from '../src/cursorfile.js';
import { chunkFileName } from '../src/logcrypt.js';
import { CodedError, errorCode } from '../src/record.js';
import { SmartThings } from '../src/smartthings.js';

const need = (k: string): string => process.env[k] || (() => { throw new CodedError(`missing-${k.toLowerCase().replace(/_/g, '-')}`); })();
try {
  const token = process.env.ST_TOKEN || (process.env.ST_TOKEN_FILE ? readFileSync(process.env.ST_TOKEN_FILE, 'utf8').trim() : '');
  if (!token) throw new CodedError('missing-st-token');
  const st = new SmartThings(token);
  const cursor = readCursor(need('STATE_FILE'), need('STATE_KEY'));
  const publicKey = readFileSync(process.env.LOGS_PUBLIC_KEY_FILE || 'config/logs.pub', 'utf8').trim();
  const res = await collectOnce({ client: st, publicKey, cursor });
  const dir = join(need('CHUNK_DIR'), 'chunks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, chunkFileName()), res.chunk, { flag: 'wx' });
  writeFileSync(need('CURSOR_OUT'), JSON.stringify({ cursor: res.cursor ?? null }));
  console.log('chunk written');
} catch (e) {
  console.log(`collector failed: ${errorCode(e)}`);
  process.exit(1);
}
