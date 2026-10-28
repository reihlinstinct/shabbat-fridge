# Design: run the collector in the public repo with encrypted logs

Status: proposal, not deployed. Needs independent review and the owner's OK before any workflow is added.

## Why
The private logs repo cannot run Actions (GitHub reports a billing block for private repos on this account). Public repos get free minutes. The owner wants the logs kept, encrypted with a secret, so the collector can run here.

## Threat model
- Everything committed here is public and permanent, including history. Treat all committed bytes as readable forever by anyone.
- Secrets exist only as Actions secrets, readable only by workflows that run from `main` (schedule, manual dispatch). Fork PRs get no secrets.
- Goals: no plaintext ids, coordinates, door timing or tokens in the repo, run logs or artifacts; minimal timing metadata.

## Design
1. **Triggers.** `schedule` (fixed cadence) and `workflow_dispatch` only. No `pull_request*` or `workflow_run` triggers. The job asserts `github.ref == refs/heads/main` and `github.repository` equals this repo. The tool code is the repo's own code at `github.sha`, so there is no separate TOOL_REF. `main` changes only through reviewed PRs.
2. **Log encryption, asymmetric.** Hybrid scheme with node:crypto only (no new dependency): per-chunk ephemeral X25519 key, ECDH with the recipient public key, HKDF-SHA256, AES-256-GCM. Only the public key lives in the repo (`config/logs.pub`). The private key is generated once, kept in the owner's vault, and never in GitHub. The workflow cannot decrypt old logs, so a leaked runner secret does not expose them. A decrypt script (`scripts/decrypt-logs.ts`) runs locally.
3. **OAuth state, symmetric.** The workflow must read and rewrite it, so it keeps the existing AES-256-GCM sealed file keyed by the `STATE_KEY` Actions secret. To avoid a permanent public history of the (constant) client secret, the sealed state lives on an orphan branch `state` that is force-pushed as a single commit each rotation. Old ciphertext is not kept in history. A lost push is covered by a short-lived artifact copy (ciphertext) and one re-authorization.
4. **Chunks, to hide activity.**
   - Every run, event or not, writes one chunk to the `logs` branch at a fixed cadence (hourly).
   - The plaintext is gzipped JSON, then padded to a fixed size bucket (16 KiB, in multiples when larger), so size does not show door activity.
   - File names are `chunks/<opaque hex id>.bin` (HMAC of a counter under the public key's hash, so no timestamps and no order hints beyond the commit).
   - Commit messages are fixed ("chunk"). Commit times show only the run cadence.
   - Weekly compaction merges old chunks into one archive and force-pushes `logs` as a single commit, which bounds repo size. This is a later PR.
5. **No leaks through Actions.** Public run logs and the step summary never get data. The analyzer runs locally on decrypted files, not in the workflow. The collector prints counts only. The token is masked. Failure alerts open a public issue with the run link and no data.
6. **Order of work (one issue and PR each).** (a) this design; (b) `statecrypt`-style hybrid crypto module plus tests (round trip, tamper, wrong key, padding sizes, canary: no plaintext in output); (c) workflow plus orphan-branch state handling plus decrypt script; (d) one-time migration of the private repo's sealed state, public key, and secret setup; (e) compaction. Nothing runs until (c) and (d) are reviewed and the owner approves.

## Residual risks
- Ciphertext is public forever. If X25519 or the private key is ever broken (including a future quantum computer), all logs from then back open. Metadata that stays visible: that the collector exists and runs hourly, and who owns the repo.
- A bad merge to `main` could exfiltrate Actions secrets or plaintext in a run. The existing gates (green CI, independent review, owner OK) are the only control. GitHub may also disable scheduled workflows in a public repo after 60 days without repo activity. The failure issue and a manual dispatch are the fallback; we will verify whether our own commits count as activity.
