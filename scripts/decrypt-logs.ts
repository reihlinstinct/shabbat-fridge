/**
 * Owner-side tool, never CI.
 *   decrypt-logs.ts keygen   LOGS_PRIVATE_KEY_FILE (new file, mode 0600, outside any git worktree). Prints the PUBLIC key only.
 *   decrypt-logs.ts decrypt  LOGS_DIR (checkout of `logs`), OUT_DIR (empty or new, outside any worktree), LOGS_PRIVATE_KEY_FILE.
 * The private key is read from a file, never from an env var or an argument. Output is fixed text and counts.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decryptDir, insideWorktree, prepareOutDir, realish, readKeyFile, refuseIfCi, writeLayout } from '../src/decryptlogs.js';
import { generateKeyPair, publicKeyOf } from '../src/logcrypt.js';
import { CodedError } from '../src/record.js';

try {
  refuseIfCi(process.env);
  const cmd = process.argv[2];
  const keyPath = process.env.LOGS_PRIVATE_KEY_FILE || '';
  if (cmd === 'keygen') {
    if (!keyPath) throw new CodedError('missing-key-file');
    if (insideWorktree(realish(dirname(resolve(keyPath))))) throw new CodedError('key-file-in-worktree');
    const { publicKey, privateKey } = generateKeyPair();
    const fd = openSync(keyPath, 'wx', 0o600);
    try {
      writeSync(fd, privateKey + '\n');
    } finally {
      closeSync(fd);
    }
    console.log('private key written to the key file. Keep that file only with the owner. Never commit or share it.');
    console.log(`public key (goes to config/logs.pub): ${publicKey}`);
  } else if (cmd === 'decrypt') {
    const logsDir = process.env.LOGS_DIR || '';
    if (!logsDir) throw new CodedError('missing-logs-dir');
    const key = readKeyFile(keyPath);
    publicKeyOf(key);
    const out = prepareOutDir(process.env.OUT_DIR || '', logsDir);
    const r = decryptDir(logsDir, key);
    const w = writeLayout(out, r.records);
    const age = r.newestTakenAt ? ((Date.now() - Date.parse(r.newestTakenAt)) / 3600000).toFixed(1) : 'none';
    console.log(`chunks ${r.chunks}, failed ${r.failed}, snapshots ${w.snapshots}, events ${w.events}, hours since newest chunk ${age}`);
    if (r.failed > 0) {
      console.log('decrypt failed: some chunks did not decrypt');
      process.exit(1);
    }
  } else {
    throw new CodedError('bad-command');
  }
} catch (e) {
  console.log(`decrypt-logs failed: ${e instanceof CodedError ? e.code : 'internal'}`);
  process.exit(1);
}
