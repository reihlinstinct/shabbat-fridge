// Two-way doc-vs-code check for the environment-variable surface.
//
// Every environment variable the product code reads must be documented, and
// every variable the docs present as configuration must be read by the code.
// Runner plumbing (scripts/ci/, GITHUB_*/RUNNER_*) and standard system
// variables are out of scope.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['scripts', 'src'];
const ALLOWLIST = join(ROOT, '.github', 'docs-vs-code-allowlist.txt');
const SYSTEM_VARS = new Set(['CI', 'HOME', 'PATH', 'TMPDIR']);
const ENV_RE = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)["']\]|\b(?:env|need)\(\s*'([A-Z][A-Z0-9_]+)'/g;
const SPAN_RE = /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g;
const BACKTICK_VAR_RE = /`([A-Z][A-Z0-9_]{2,})`/g;
const ASSIGN_RE = /\b([A-Z][A-Z0-9_]{2,})=/g;

function* walk(dir: string, ext: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path, ext);
    else if (path.endsWith(ext)) yield path;
  }
}

function allowlist(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(ALLOWLIST)) return out;
  for (const raw of readFileSync(ALLOWLIST, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const hash = line.indexOf('#');
    if (hash < 0 || !line.slice(hash + 1).trim()) throw new Error(`allowlist entry without a reason: ${line}`);
    out.set(line.slice(0, hash).trim(), line.slice(hash + 1).trim());
  }
  return out;
}

function codeEnv(): Set<string> {
  const out = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const path of walk(join(ROOT, dir), '.ts')) {
      const rel = relative(ROOT, path);
      if (rel.startsWith(join('scripts', 'ci'))) continue;
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(ENV_RE)) {
        const token = m[1] ?? m[2] ?? m[3];
        if (token.startsWith('GITHUB_') || token.startsWith('RUNNER_') || SYSTEM_VARS.has(token)) continue;
        out.add(token);
      }
    }
  }
  return out;
}

function docFiles(): string[] {
  return [join(ROOT, 'README.md'), ...walk(join(ROOT, 'docs'), '.md')];
}

function docEnv(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(BACKTICK_VAR_RE)) out.add(m[1]);
  for (const s of text.matchAll(SPAN_RE)) {
    const span = s[1] ?? s[2];
    for (const m of span.matchAll(ASSIGN_RE)) out.add(m[1]);
  }
  return out;
}

describe('docs vs code: environment variables', () => {
  it('documents every variable the code reads', () => {
    const text = docFiles().map((p) => readFileSync(p, 'utf8')).join('\n');
    const allowed = allowlist();
    const missing = [...codeEnv()].filter((tok) => !new RegExp(`\\b${tok}\\b`).test(text) && !allowed.has(tok)).sort();
    expect(missing, `environment variables missing from docs: ${missing}`).toEqual([]);
  });

  it('every documented variable exists in code', () => {
    const known = new Set([...codeEnv(), ...allowlist().keys()]);
    const stale: string[] = [];
    for (const doc of docFiles()) {
      for (const token of docEnv(readFileSync(doc, 'utf8'))) {
        if (token.startsWith('GITHUB_') || token.startsWith('RUNNER_')) continue;
        if (!known.has(token)) stale.push(`${relative(ROOT, doc)}: ${token}`);
      }
    }
    expect(stale.sort(), `documented variables missing from code: ${stale}`).toEqual([]);
  });

  it('catches a fake variable in a fenced block', () => {
    expect(docEnv('```bash\nTOTALLY_FAKE_VAR=1 npm run collect\n```\n').has('TOTALLY_FAKE_VAR')).toBe(true);
  });

  it('catches a fake variable in an inline command', () => {
    expect(docEnv('`TOTALLY_FAKE_VAR=1 npm run collect`').has('TOTALLY_FAKE_VAR')).toBe(true);
  });
});
