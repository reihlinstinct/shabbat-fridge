/**
 * Git storage steps for the collector workflow (see src/branchstore.ts). The remote is pinned to this project's repository.
 *   read-state   STATE_FILE (output path), STATE_SHA_FILE
 *   write-state  STATE_FILE (input), STATE_SHA_FILE (expected sha in, new sha out)
 *   write-logs   CHUNK_DIR (reads CHUNK_DIR/chunks/*.bin)
 * GH_TOKEN is the per-run github.token. It reaches git only through its environment config. Output is fixed text only.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BranchStore } from '../src/branchstore.js';
import { CodedError } from '../src/record.js';

export const REPO = 'reihlinstinct/shabbat-fridge';
const cmd = process.argv[2];
try {
  const token = process.env.GH_TOKEN || '';
  // STORE_REMOTE exists for tests and is ignored inside GitHub Actions, so the workflow can only talk to this repository.
  const remote = !process.env.GITHUB_ACTIONS && process.env.STORE_REMOTE ? process.env.STORE_REMOTE : `https://github.com/${REPO}.git`;
  let extraHeader: string | undefined;
  if (token && remote.startsWith('https://')) {
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${b64}`);
    extraHeader = `AUTHORIZATION: basic ${b64}`;
  }
  const store = new BranchStore({ repoDir: process.cwd(), remote, extraHeader });
  const need = (k: string): string => process.env[k] || (() => { throw new CodedError(`missing-${k.toLowerCase().replace(/_/g, '-')}`); })();
  if (cmd === 'read-state') {
    const r = store.readState();
    if (!r) throw new CodedError('state-missing');
    mkdirSync(dirname(need('STATE_FILE')), { recursive: true });
    writeFileSync(need('STATE_FILE'), r.content, { mode: 0o600 });
    writeFileSync(need('STATE_SHA_FILE'), r.sha);
    console.log('state read');
  } else if (cmd === 'write-state') {
    const expected = readFileSync(need('STATE_SHA_FILE'), 'utf8').trim();
    const sha = store.writeState(readFileSync(need('STATE_FILE'), 'utf8'), expected);
    writeFileSync(need('STATE_SHA_FILE'), sha);
    console.log('state written');
  } else if (cmd === 'write-logs') {
    const dir = join(need('CHUNK_DIR'), 'chunks');
    const files = readdirSync(dir).map((n) => ({ path: `chunks/${n}`, data: readFileSync(join(dir, n)) }));
    store.writeLogs(files);
    console.log('logs written');
  } else {
    throw new CodedError('bad-command');
  }
} catch (e) {
  console.log(`store failed: ${e instanceof CodedError ? e.code : 'internal'}`);
  process.exit(1);
}
