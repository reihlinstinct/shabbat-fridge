# Unattended token, snapshots and yearly rules / טוקן אוטומטי

**Problem:** a SmartThings personal token lasts 24 hours. An **OAuth-In app** gives a refresh token instead, so a workflow can get a fresh 24h token by itself.
Source: https://developer.smartthings.com/docs/service-integrations/token-management (refresh tokens are single-use; each refresh returns a new one) and a SmartThings staff answer that an
unused refresh token expires after **29 days**: https://community.smartthings.com/t/token-error-401-after-few-hrs/300628.

## How it works
- State (OAuth client id + secret, the current refresh token, a cached access token) is one JSON file, **encrypted** with AES-256-GCM (`src/statecrypt.ts`), at `state/oauth.enc.json` in the **private** logs repo.
- The key is the only secret: repo secret `STATE_KEY` of the private repo. The key and the ciphertext never go to the public repo.
- The workflow template `docs/forensics/unattended.yml` (copied into the private repo) runs every 30 minutes:
  1. fails closed unless the repo is exactly the private logs repo and the tool is pinned to a commit SHA;
  2. refreshes only if the cached access token has under 2 hours left (about once a day), commits the new sealed state **first** (retries; ciphertext also kept as a 3-day artifact), then
  3. takes the read-only snapshot, runs the analyzer, commits the data;
  4. optionally runs the rule installer (manual input, or yearly when the repository variable `YEARLY_INSTALL` is `true`; needs an app authorized with `w:rules:*`);
  5. on any failure opens or updates an issue labelled `fridge-alert` in the private repo (GitHub also emails failed scheduled runs).
- One run at a time (`concurrency` group), because the refresh token is single-use.
- Fail closed: a refresh that fails, or returns no new refresh token, never overwrites the stored state (tested byte for byte).
- No token or response body is printed or put in an error; GitHub masks the access token in logs.

## One-time setup: what is automatic and what needs you
| # | Who | What |
|---|-----|------|
| 1 | you | Create a SmartThings token at https://account.smartthings.com/tokens with the app-management scopes (Apps) and give it to Instinct through a secure vault link. It lasts 24h and is used once. |
| 2 | Instinct | `oauth-setup create-app`: creates the OAuth-In app (scopes `r:locations r:devices r:rules`, add `w:rules` for the yearly installer), redirect URI = the static page `https://reihlinstinct.github.io/shabbat-fridge/oauth-callback.html`; checks the stored scopes (a reported SmartThings bug turns `*` into `$`). Prints no secret. |
| 3 | you | Open the authorization link Instinct sends, sign in to Samsung, press Allow. The page shows a one-time value `code~state`. Paste all of it into a second secure vault link (the state part binds it to the link Instinct issued). |
| 4 | Instinct | `oauth-setup exchange`, seals the state, commits it to the private repo, sets `STATE_KEY`, pins the tool SHA, enables the workflow, checks the first run. |

If step 2 reports the scope bug, or the apps API refuses the token, the fallback is the CLI: `smartthings apps:create` (OAuth-In App), then the same steps 3-4.

## Limits and recovery
- **29-day idle limit:** if no run refreshes the token for 29 days, the refresh token dies and the workflow fails with `invalid_grant`. The cure is one re-authorization (steps 3-4 only, the app stays). The 30-minute schedule makes this unlikely, but GitHub may disable scheduled workflows after 60 days without repository activity (snapshot commits count as activity), and may delay or skip runs.
- If the push of the new state fails after a refresh, the old refresh token is already dead. The ciphertext artifact (3 days) is the backup; otherwise re-authorize once.
- Anyone who can read the private repo **and** `STATE_KEY` can control the fridge's rules. Keep the repo private and do not add collaborators. Revoke by deleting the app in SmartThings (or the secret and the state file).
- Git history keeps every old sealed state. They are dead (single-use) and still encrypted.
- This is unverified against the live SmartThings endpoints until setup runs: the app-creation call shape and the hosts used by the authorization endpoint (the CLI uses regional hosts; the docs say api.smartthings.com).
- Alternative backend (not built): a GitHub App with Secrets: write on one repo, to keep the refresh token as a repo secret instead of an encrypted file. More clicks, no ciphertext in Git.
