# Runbook: the encrypted collector

For the owner and for whoever operates the repository. Design and reasons: docs/ENCRYPTED-LOGS.md and docs/ENCRYPTED-LOGS-COLLECTOR.md. Never paste a key, token or log content into an issue, a pull request, a run log or a chat.

## Is it alive?
- The newest commit on branch `logs` should be less than about 2 hours old: `https://github.com/reihlinstinct/shabbat-fridge/commits/logs` (no login needed). Instinct also checks this every 2 hours and reports when it is older than 3 hours.
- The `collector` workflow runs hourly. A failed run opens one issue labelled `collector-alert` (run link only, at most one comment per day). The run log shows fixed text only, so a failure code is the only clue there; reproduce locally to see more.

## Stop it
Set the repository variable `COLLECTOR_ENABLED` to anything other than `true` (Settings, Secrets and variables, Actions, Variables). The `collect` job is then skipped on the next schedule. To stop for longer, also disable the workflow in the Actions tab. The `keepalive` workflow re-enables a workflow GitHub disabled for inactivity, so disable `keepalive` too if the stop must hold.

## Start it again
Set `COLLECTOR_ENABLED` to `true`, then run the `collector` workflow once by hand (Actions, collector, Run workflow) and check that the newest `logs` commit is fresh.

## Read the logs
Only the holder of the log private key can. Steps and options for the owner: see "Decrypt" in docs/ENCRYPTED-LOGS-COLLECTOR.md (c4). The key is never put in GitHub.

## The rotating OAuth token was lost
Signs: a run fails at the rotate step (fixed text `rotate failed: oauth-failed`). Causes: the single-use refresh token was used by a run that could not save the new state, or it was idle for 29 days.
1. Within 1 day of a run that rotated, the artifact `sealed-state` of that run holds the new sealed state (ciphertext only). Download it and write it to the `state` branch with `scripts/store.ts write-state` (needs `STATE_FILE`, `STATE_SHA_FILE` and a token that can push).
2. Otherwise authorize the SmartThings app again as described in docs/UNATTENDED.md and seal the new state with the current `STATE_KEY`.

## Rotate `STATE_KEY` (yearly, or after any suspected leak)
1. Generate a new random key (for example `openssl rand -base64 32`).
2. Re-seal the state with the new key and write it to the `state` branch, then change the secret right away (step 3). A run between the two steps fails closed with a fixed error and the next run recovers, so do both within a few minutes, away from the top of the hour. On a machine with Node and a clone of the repository, the old and new keys in environment variables only (never in arguments):
   - `GH_TOKEN=<token that can push to the state branch> STATE_FILE=/tmp/oauth.enc.json STATE_SHA_FILE=/tmp/oauth.sha npx tsx scripts/store.ts read-state`
   - `STATE_FILE=/tmp/oauth.enc.json OLD_STATE_KEY=<old> NEW_STATE_KEY=<new> npx tsx scripts/reseal-state.ts` (prints `state re-sealed`; the file is replaced only after a read-back check)
   - `GH_TOKEN=<same> STATE_FILE=/tmp/oauth.enc.json STATE_SHA_FILE=/tmp/oauth.sha npx tsx scripts/store.ts write-state`
   - delete `/tmp/oauth.enc.json` and `/tmp/oauth.sha`.
3. Update the secret `STATE_KEY` in the `collector` Environment.
4. After a suspected leak also follow the compromise playbook in docs/ENCRYPTED-LOGS.md (delete and recreate the OAuth app, force-push `state`).

## Replace the log key pair
Make a new key, put its public key in `config/logs.pub` through a pull request, keep the old private key as long as old chunks must stay readable. Chunks written before the change stay encrypted to the old key.

## What not to do
- Do not add a trigger other than `schedule` and `workflow_dispatch`. `test/workflows.test.ts` fails if a workflow is loosened.
- Do not print anything from the collector steps. Run logs of a public repository are public.
- Do not commit anything under `logs` or `state` by hand.
