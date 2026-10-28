// Runs branch store operations, including failing ones, with canary values everywhere. It must print nothing at all.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BranchStore } from '../../src/branchstore.js';

const root = mkdtempSync(join(tmpdir(), 'sr-'));
const remote = join(root, 'CANARY-remote.git');
execFileSync('git', ['init', '--bare', '-q', remote], { stdio: 'ignore' });
const work = join(root, 'work');
execFileSync('git', ['init', '-q', work], { stdio: 'ignore' });
const header = 'Authorization: basic CANARY-HEADER';
const store = new BranchStore({ repoDir: work, remote, extraHeader: header });
const attempt = (f: () => unknown): void => { try { f(); } catch { /* fixed codes only; nothing printed */ } };
const a = store.writeState('CANARY-STATE', null);
attempt(() => store.writeState('CANARY-LOST', '0'.repeat(40)));
attempt(() => store.writeState('CANARY-TWO', a));
attempt(() => store.writeLogs([{ path: `chunks/${'a'.repeat(32)}.bin`, data: Buffer.from('CANARY-CHUNK') }]));
attempt(() => store.writeLogs([{ path: 'CANARY/../x', data: Buffer.from('x') }]));
attempt(() => new BranchStore({ repoDir: work, remote: '--upload-pack=CANARY' }));
attempt(() => new BranchStore({ repoDir: work, remote: '/nonexistent/CANARY' }).readState());
process.env.TMPDIR = '/nonexistent/CANARY-TMP';
attempt(() => store.writeState('CANARY-TMP-CONTENT', null));
