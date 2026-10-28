/**
 * Git branch storage for the public-repo collector (c2 of docs/ENCRYPTED-LOGS-COLLECTOR.md).
 * - `state`: an orphan branch with one file. Every write is a new parentless commit pushed with a lease on the sha we read
 *   (expected-absent on first creation). Old commits are NOT erased: they stay fetchable until GitHub collects them.
 * - `logs`: only new files under chunks/, fast-forward pushes, bounded retries.
 * Commit messages and identities are fixed. Nothing is printed and git's own messages are never passed on:
 * every failure is a CodedError with a fixed code.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodedError } from './record.js';

export const STATE_FILE = 'state/oauth.enc.json';
export const MAX_PUSH_TRIES = 5;
const IDENT = { name: 'fridge-logs', email: 'fridge-logs@users.noreply.github.com' };
const CHUNK_PATH = /^chunks\/[0-9a-f]{32}\.bin$/;
const SHA = /^[0-9a-f]{40}$/;

export interface StoreOptions {
  /** A git repository directory (any clone or an empty `git init`). */
  repoDir: string;
  /** Remote URL or path. */
  remote: string;
  /** Optional `Authorization: ...` header line passed as http.extraheader (never printed). */
  extraHeader?: string;
  /** Test hook: runs right before each push attempt of writeLogs. */
  beforePush?: (attempt: number) => void;
}

export class BranchStore {
  constructor(private readonly o: StoreOptions) {}

  private git(args: string[], opts: { env?: Record<string, string>; input?: string; code: string }): string {
    const pre = this.o.extraHeader ? ['-c', `http.extraheader=${this.o.extraHeader}`] : [];
    try {
      return execFileSync('git', ['-C', this.o.repoDir, ...pre, ...args], {
        encoding: 'utf8',
        input: opts.input,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: IDENT.name, GIT_AUTHOR_EMAIL: IDENT.email, GIT_COMMITTER_NAME: IDENT.name, GIT_COMMITTER_EMAIL: IDENT.email, ...opts.env },
      });
    } catch {
      throw new CodedError(opts.code);
    }
  }

  /** The sha of a remote branch, or null when it does not exist. A failing remote throws `fetch-failed`. */
  private remoteSha(branch: string): string | null {
    const out = this.git(['ls-remote', '--heads', this.o.remote, `refs/heads/${branch}`], { code: 'fetch-failed' }).trim();
    if (!out) return null;
    const sha = out.split(/\s+/)[0] ?? '';
    if (!SHA.test(sha)) throw new CodedError('fetch-failed');
    return sha;
  }

  private fetchSha(sha: string): void {
    this.git(['fetch', '--no-tags', '--quiet', this.o.remote, sha], { code: 'fetch-failed' });
  }

  /** Build a commit whose tree is `base` (optional) plus the given files. No working tree is touched. */
  private commit(files: Array<{ path: string; data: Buffer }>, parent: string | null, message: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bs-'));
    try {
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      if (parent) this.git(['read-tree', parent], { env, code: 'push-failed' });
      for (const f of files) {
        const blob = join(dir, 'blob');
        writeFileSync(blob, f.data);
        const sha = this.git(['hash-object', '-w', blob], { code: 'push-failed' }).trim();
        this.git(['update-index', '--add', '--cacheinfo', `100644,${sha},${f.path}`], { env, code: 'push-failed' });
      }
      const tree = this.git(['write-tree'], { env, code: 'push-failed' }).trim();
      const args = ['commit-tree', tree, '-m', message];
      if (parent) args.push('-p', parent);
      const sha = this.git(args, { code: 'push-failed' }).trim();
      if (!SHA.test(sha)) throw new CodedError('push-failed');
      return sha;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Read the sealed state file and the branch sha. `null` when the branch does not exist yet. */
  readState(): { sha: string; content: string } | null {
    const sha = this.remoteSha('state');
    if (!sha) return null;
    this.fetchSha(sha);
    return { sha, content: this.git(['show', `${sha}:${STATE_FILE}`], { code: 'fetch-failed' }) };
  }

  /**
   * Replace the state with a new parentless commit. `expectedSha` is the sha from readState (null = the branch must not exist).
   * Returns the new sha, to be used as the expected sha of a later write in the same run.
   */
  writeState(content: string, expectedSha: string | null): string {
    if (expectedSha !== null && !SHA.test(expectedSha)) throw new CodedError('push-failed');
    const sha = this.commit([{ path: STATE_FILE, data: Buffer.from(content, 'utf8') }], null, 'state');
    this.git(['push', '--quiet', `--force-with-lease=refs/heads/state:${expectedSha ?? ''}`, this.o.remote, `${sha}:refs/heads/state`], { code: 'push-failed' });
    return sha;
  }

  /**
   * Add new chunk files to `logs` with fast-forward pushes. A rejected push is retried on the new tip, at most MAX_PUSH_TRIES times.
   * Only `chunks/<32 hex>.bin` paths are accepted, and an existing path is never replaced.
   */
  writeLogs(files: Array<{ path: string; data: Buffer }>): string {
    if (files.length === 0) throw new CodedError('push-failed');
    for (const f of files) if (!CHUNK_PATH.test(f.path)) throw new CodedError('push-failed');
    for (let attempt = 1; attempt <= MAX_PUSH_TRIES; attempt++) {
      const tip = this.remoteSha('logs');
      if (tip) this.fetchSha(tip);
      if (tip) {
        const existing = new Set(this.git(['ls-tree', '-r', '--name-only', tip], { code: 'fetch-failed' }).split('\n'));
        if (files.some((f) => existing.has(f.path))) throw new CodedError('push-failed');
      }
      const sha = this.commit(files, tip, 'chunk');
      this.o.beforePush?.(attempt);
      try {
        this.git(['push', '--quiet', this.o.remote, `${sha}:refs/heads/logs`], { code: 'push-failed' });
        return sha;
      } catch (e) {
        if (attempt === MAX_PUSH_TRIES) throw e;
      }
    }
    throw new CodedError('push-failed');
  }
}
