# Design (item c): the public-repo collector, state branch and decrypt script

Status: proposal. Builds on docs/ENCRYPTED-LOGS.md (merged) and src/logcrypt.ts (merged). No code, workflow, key or secret exists yet for this item. Nothing runs until the code PRs are reviewed and the owner approves; item (d) sets up keys and secrets.

## Problem this item must solve
The old collector deduplicated history events by reading its earlier files. In the public repo the workflow can read no old logs (it holds only the public key). So the new collector must be stateless with respect to logs, and keep any cursor in the sealed OAuth state, which it can read.

## Pieces (one PR each, in this order)
1. **Slim record and cursor (`src/record.ts`, `scripts/collect-encrypted.ts`).**
   - One run builds one JSON record: `{ v: 1, takenAt, place, sabbath, rules, events }`. The raw `status` blob is dropped (it is about 50 KB of mostly irrelevant data; `analyze` reads only `place`, `sabbath` and the snapshot times). `rules` keeps id, name, status, dateExecuted, dateUpdated.
   - `events` holds only history events newer than `eventCursor`, minus a 1 hour overlap. Duplicates from the overlap are removed later by the existing event key on decrypt.
   - `eventCursor` (ISO time of the newest event seen, or absent on the first run, which then takes the whole ~7-day history) is an optional field of the sealed OAuth state (validated as an ISO timestamp on open). It advances only after the chunk is pushed. If that second state write fails, the next run re-sends the overlap and nothing is lost.
   - The record is gzipped and encrypted with `sealJson`, context `shabbat-fridge/logs/record/v1`, bucket 16 KiB (a 50 KB status gzips to 7 KB, so the slim record plus one week of events should fit one chunk; if the first run spills, that is a single visible step on day one only). It is written to `chunks/<chunkFileName()>.bin`, one file per chunk.
   - Console output is fixed text only ("chunk written"). It never prints event counts, sabbath state, ids or timestamps from the data, because the run log is public and a count would leak door activity.
2. **State branch handling (`src/branchstore.ts`).**
   - `state` is an orphan branch with one file, `state/oauth.enc.json`. Each write creates a new parentless commit and pushes with `--force-with-lease=state:<sha we read>`, so a concurrent writer fails instead of overwriting. As in the main design, this keeps the branch small but does not erase old commits.
   - `logs` is a normal branch that only receives new files (fast-forward pushes with pull --rebase retries). No force pushes there.
   - Tested against a local bare repository: first create, update, lease conflict, rebase retry, no stray files, fixed commit messages.
3. **Workflow (`.github/workflows/collector.yml`) and keepalive (`keepalive.yml`).** As in the main design: triggers `schedule` (hourly) and `workflow_dispatch` with no inputs; a first step that asserts repository, event name and `refs/heads/main` before any secret exists in the environment; one concurrency group `collector`, `cancel-in-progress: false`; per-job permissions (collector: `contents: write`, `issues: write`; keepalive: `actions: write` only); environment `collector` for `STATE_KEY`; actions pinned by full SHA; `persist-credentials: false` on checkout and the push done in one step with the token passed via `http.extraheader`; no `set -x`, no `env`, no step debug dependence; artifacts of ciphertext with `retention-days: 1`; failure alert issue with the run link and no data. Order inside the run: guard, checkout, install (`npm ci --ignore-scripts`), fetch `state` and `logs`, rotate (token first), push state, upload the ciphertext artifact, collect and write the chunk, push `logs`, update the cursor (second state push). The collector reads the public key from `config/logs.pub` and validates it is 32 bytes.
   - A repository test (`test/workflows.test.ts`) parses every workflow file and fails the build if: a `pull_request*`, `workflow_run` or `issue*` trigger appears; an action is not pinned to a 40-hex SHA; a job lacks an explicit `permissions` block; the collector job has no concurrency group or environment; `set -x`, `printenv` or a bare `env` appears; an artifact has no `retention-days: 1`.
4. **Decrypt script (`scripts/decrypt-logs.ts`).**
   - Input: `LOGS_DIR` (a checkout of the `logs` branch), `OUT_DIR`, and `LOGS_PRIVATE_KEY_FILE` (a path, never the key value in an environment variable or argument).
   - It refuses to run when `GITHUB_ACTIONS` is set, so the private key never reaches CI. It refuses an `OUT_DIR` inside the repository working tree or any git worktree.
   - It decrypts every chunk, groups spilled chunks, dedupes events by their key, and writes the same `snapshots/YYYY-MM/*.json` and `events/YYYY-MM.ndjson` layout, so `scripts/analyze.ts` works unchanged. A chunk that does not decrypt is counted and the exit code is non-zero; nothing is dropped silently. Output is counts only, no data.
   - Tests: round trip, spill, duplicate events removed, tampered and foreign-key chunks counted, refusal under CI, refusal for an output inside a git tree, canary never printed.

## Out of scope here
Keys, secrets, the Environment, migration of the sealed state and enabling the schedule (item d); compaction (item e). Each needs its own review and the owner's OK.

## Risks specific to this item
- The cursor lives in the sealed state, so a leaked `STATE_KEY` plus a scraped state reveals roughly when the last event was seen, not the events.
- A failed second state write only causes duplicate events, removed on decrypt. A failed first state write after a refresh is the known crash window (ciphertext artifact backup, then one re-authorization).
- Hourly cadence means a mode change that is reversed between two runs is invisible, as with any polling; the analyzer reports the largest gap.
