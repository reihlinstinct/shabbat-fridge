/**
 * Local decryption of collector chunks (docs/ENCRYPTED-LOGS-COLLECTOR.md, c4). Runs on the owner's side only, never in CI.
 * Pure over a directory and a key: errors carry fixed codes, never key bytes, paths of keys or decrypted text.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { RECORD_CONTEXT } from './collectrun.js';
import { assemble, decryptChunk, type Decrypted } from './logcrypt.js';
import { CodedError, type LogRecord } from './record.js';

const NAME = /^[0-9a-f]{32}\.bin$/;

/** True when the path or any ancestor holds a `.git` entry (directory or file). The path itself need not exist. */
export function insideWorktree(path: string): boolean {
  let p = resolve(path);
  for (;;) {
    try {
      lstatSync(join(p, '.git'));
      return true;
    } catch {
      /* no .git here */
    }
    const up = dirname(p);
    if (up === p) return false;
    p = up;
  }
}

/** realpath of the longest existing prefix, with the missing tail appended. */
export function realish(path: string): string {
  let p = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(p), ...tail.reverse());
    } catch {
      tail.push(p.slice(dirname(p).length + 1));
      const up = dirname(p);
      if (up === p) return resolve(path);
      p = up;
    }
  }
}

export function refuseIfCi(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_ACTIONS || env.CI) throw new CodedError('refused-ci');
}

/** Reads a private key file after the safety checks. Returns the key text (trimmed). */
export function readKeyFile(path: string): string {
  if (!path) throw new CodedError('missing-key-file');
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new CodedError('key-file-unreadable');
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new CodedError('key-file-not-regular');
  if ((st.mode & 0o077) !== 0) throw new CodedError('key-file-mode');
  if (insideWorktree(realish(path))) throw new CodedError('key-file-in-worktree');
  return readFileSync(path, 'utf8').trim();
}

/** Validates OUT_DIR against LOGS_DIR and creates it 0700. */
export function prepareOutDir(out: string, logsDir: string): string {
  if (!out) throw new CodedError('missing-out-dir');
  const real = realish(out);
  const logs = realish(logsDir);
  if (insideWorktree(real)) throw new CodedError('out-in-worktree');
  if (real === logs || real.startsWith(logs + sep)) throw new CodedError('out-in-logs-dir');
  try {
    if (!statSync(real).isDirectory()) throw new CodedError('out-not-dir');
    if (readdirSync(real).length > 0) throw new CodedError('out-not-empty');
  } catch (e) {
    if (e instanceof CodedError) throw e;
    mkdirSync(real, { recursive: true, mode: 0o700 });
  }
  return real;
}

export interface DecryptResult {
  chunks: number;
  failed: number;
  records: LogRecord[];
  newestTakenAt: string | undefined;
}

/** Decrypts every chunk under LOGS_DIR/chunks. Anything that does not decrypt, assemble or parse counts as a failure. */
export function decryptDir(logsDir: string, privateKey: string): DecryptResult {
  const dir = join(logsDir, 'chunks');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new CodedError('no-chunks-dir');
  }
  let failed = 0;
  const groups = new Map<string, Decrypted[]>();
  for (const n of names) {
    if (!NAME.test(n)) {
      failed++;
      continue;
    }
    try {
      const d = decryptChunk(readFileSync(join(dir, n)), privateKey, RECORD_CONTEXT);
      groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
    } catch {
      failed++;
    }
  }
  const records: LogRecord[] = [];
  for (const parts of groups.values()) {
    try {
      const r = JSON.parse(gunzipSync(assemble(parts)).toString('utf8')) as LogRecord;
      if (r === null || typeof r !== 'object' || r.v !== 1 || typeof r.takenAt !== 'string' || !Number.isFinite(Date.parse(r.takenAt)) || !Array.isArray(r.events)) throw new Error('shape');
      records.push(r);
    } catch {
      failed += parts.length;
    }
  }
  records.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  return { chunks: names.length, failed, records, newestTakenAt: records.at(-1)?.takenAt };
}

/** Writes snapshots/YYYY-MM/<takenAt>.json and events/YYYY-MM.ndjson (events deduplicated by k). Returns counts. */
export function writeLayout(out: string, records: LogRecord[]): { snapshots: number; events: number } {
  const seen = new Set<string>();
  const byMonth = new Map<string, string[]>();
  let snapshots = 0;
  const done = new Set<string>();
  for (const r of records) {
    if (!done.has(r.takenAt)) {
      done.add(r.takenAt);
      const { events: _events, ...snap } = r;
      const month = r.takenAt.slice(0, 7);
      mkdirSync(join(out, 'snapshots', month), { recursive: true, mode: 0o700 });
      writeFileSync(join(out, 'snapshots', month, `${r.takenAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(snap, null, 1), { mode: 0o600 });
      snapshots++;
    }
    for (const e of r.events) {
      if (typeof e?.k !== 'string' || seen.has(e.k)) continue;
      seen.add(e.k);
      const t = Date.parse(e.time);
      const month = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : 'unknown';
      byMonth.set(month, [...(byMonth.get(month) ?? []), JSON.stringify(e)]);
    }
  }
  mkdirSync(join(out, 'events'), { recursive: true, mode: 0o700 });
  for (const [m, lines] of byMonth) writeFileSync(join(out, 'events', `${m}.ndjson`), lines.join('\n') + '\n', { mode: 0o600 });
  return { snapshots, events: seen.size };
}
