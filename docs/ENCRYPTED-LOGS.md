# Design: run the collector in the public repo with encrypted logs

Status: proposal, not deployed. Needs independent review and the owner's OK before any workflow is added.

## Why
The private logs repo cannot run Actions (GitHub reports a billing block for private repos on this account). Public repos get free minutes. The owner wants the logs kept, encrypted with a secret, so the collector can run here. The owner chose to keep raw snapshots, not only aggregates. That is his choice and it raises the stakes of the residual risks below.

## Threat model
- Everything committed here is public and permanent. Force-pushing or deleting a branch does not erase it: unreachable commits stay fetchable by hash until GitHub garbage-collects them, and may be scraped or cached first. Treat every committed byte as readable forever by anyone.
- Secrets exist only as Actions secrets. Fork PRs get none.
- Goals: no plaintext ids, coordinates, door timing or tokens in the repo, run logs or artifacts; minimal timing metadata.

## Design
1. **Triggers and job hardening.** Only `schedule` and `workflow_dispatch`. No `pull_request*`, `workflow_run` or `issue*` triggers. The job asserts `github.repository` is this repo, `github.event_name` is schedule or workflow_dispatch, and `github.ref` is `refs/heads/main`, else it exits before reading any secret. `permissions: contents: write` only, plus `issues: write` for the failure alert. All actions pinned by full commit SHA. No `set -x`, no env dumps, no step-debug reliance; secrets are passed only to the one step that needs them. The tool code is the repo's own code at `github.sha`, so there is no separate TOOL_REF; `main` changes only through reviewed PRs.
2. **One run at a time.** One `concurrency` group for scheduled and manual runs, `cancel-in-progress: false`. A second run can not start from an old sealed state while the first is rotating, which would roll back the single-use refresh token.
3. **Secret scoping.** `STATE_KEY` lives in a GitHub Environment (`collector`) restricted to deployment branch `main`, not as a plain repo secret. The job uses that environment.
4. **Log encryption, asymmetric.** Hybrid scheme with node:crypto only (no new dependency). Fixed format:
   - Byte 0 is a version (`1`). Then the 32-byte ephemeral X25519 public key, a random 96-bit nonce, then ciphertext and the 16-byte GCM tag.
   - A fresh ephemeral key and a fresh random nonce for every chunk. The shared secret goes through HKDF-SHA256 with salt = ephemeral pub || recipient pub and info = `shabbat-fridge/logs/v1`, giving a 256-bit AES-GCM key.
   - AAD binds the version byte, the ephemeral public key and the chunk context string, so a chunk cannot be replayed under another label or format.
   - Only the public key is in the repo (`config/logs.pub`). The private key is generated once off CI, stored in the owner's vault, and never put in GitHub, a secret, or a run. The workflow cannot decrypt old logs. A local script (`scripts/decrypt-logs.ts`) does that.
5. **OAuth state, symmetric.** The workflow must read and rewrite it, so it keeps the existing AES-256-GCM sealed file keyed by `STATE_KEY`. It is stored on an orphan `state` branch as a single commit per rotation. This keeps the branch small, but old states are NOT erased: they stay fetchable. Consequence: if `STATE_KEY` ever leaks, every scraped state decrypts. The constant client secret is exposed, and any refresh token that is still unused. Refresh tokens are single-use and rotated, so only the latest matters, but the client secret is permanent until regenerated (see playbook).
6. **Chunks, to hide activity.** Every run, event or not, writes one chunk to the `logs` branch at a fixed cadence (hourly). Plaintext is gzipped JSON padded to a fixed bucket (16 KiB). File names are `chunks/<random 128-bit hex id>.bin`, with no counter, HMAC or timestamp. Commit messages are fixed ("chunk"). The commit time shows only the run cadence. Spill: a snapshot that no longer fits one bucket is split into more chunks, so a burst of activity shows up as a visible size step. Raising the bucket size before that happens is the mitigation. Weekly compaction (later PR) merges old chunks to bound repo size; it cannot erase earlier public history either.
7. **No leaks through Actions.** Run logs and the step summary never carry data; the collector prints counts only. The analyzer runs locally on decrypted files. The token is masked. Uploaded artifacts hold ciphertext only, with `retention-days: 1`. The failure alert opens a public issue with the run link and no data.
8. **Scheduled workflow keepalive.** GitHub disables schedules in a public repo after 60 days without repo activity. Our hourly pushes to `logs` are likely activity, but this is unverified for pushes by `GITHUB_TOKEN`. Plan: a monthly keepalive job that calls the Actions API to re-enable the workflow if it is disabled (needs `actions: write`, in a separate job), and we verify the behavior on a first test and note the result in this doc. If the collector stops, the next failure issue or missing chunk is the signal.
9. **Scopes and crash window.** The unattended OAuth app has `r:locations`, `r:devices`, `r:rules`, `w:rules`. It has no device-control scope, so a leak can change rules but not toggle the fridge. A read-only app is the least-privilege option if the yearly installer is run manually instead. A crash between the refresh and the push of the new sealed state loses the single-use refresh token. The ciphertext artifact backup (1 day) covers most cases; otherwise one re-authorization fixes it.
10. **Compromise playbooks.**
    - `STATE_KEY` leak: rotate the secret, delete the OAuth app, create a new one and authorize again (new client secret, new refresh token), force-push the `state` branch. Old scraped states are then useless.
    - Log private key leak: generate a new keypair, change `config/logs.pub`, new chunks are safe; old chunks stay readable to the attacker. Nothing can be done for the past, so plaintext sensitivity is the real limit.
    - Suspected bad merge or workflow change: disable the workflow, revoke the OAuth app, rotate both keys.
    - Routine: rotate `STATE_KEY` and re-seal once a year.
11. **Order of work (one issue and PR each).** (a) this design; (b) the hybrid crypto module and tests (round trip, tamper, wrong key, wrong AAD, padding sizes, nonce uniqueness, no plaintext in output); (c) the workflow, orphan-branch state handling, decrypt script; (d) migration and setup (public key, environment, secrets, move the sealed state); (e) compaction. Nothing runs until (c) and (d) are reviewed and the owner approves.

## Residual risks
- Ciphertext is public forever. A future break of X25519 or a leak of the private key opens all raw logs back to the start. The collector's existence and hourly cadence stay visible, and a bucket spill shows a size step.
- A leaked `STATE_KEY` exposes every scraped sealed state. A bad merge to `main` could exfiltrate secrets or plaintext in a run, so CI, independent review and the owner's OK are the only control.
