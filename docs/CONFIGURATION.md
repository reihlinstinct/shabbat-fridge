# Configuration reference

All environment variables the scripts read, grouped by script. Everything is
passed in the environment; no value is committed. Variables marked optional
have a working default or auto-detection.

## scripts/install.ts (rule installer)

- `ST_TOKEN` - SmartThings personal access token (required).
- `DRY_RUN` - dry run unless `DRY_RUN=false` (default: dry run).
- `YEARS` - how many years ahead to install (default 10).
- `ENTRY`, `EXIT`, `REENTER` - minutes before sunset / after sunset / re-entry offset (defaults 60/90/100).
- `YOM_KIPPUR` - include the Yom Kippur rule (`true`/`false`).
- `ISRAEL` - override the Israel schedule detection (`true`/`false`; default: from the location country).
- `CALENDAR` - calendar input for the Israel detection (default `auto`).
- `LOCATION_ID`, `DEVICE_ID` - optional; auto-detected when the account has exactly one.
- `PRUNE` - remove rules this tool no longer manages (default `false`).
- `START` - first day to cover, `YYYY-MM-DD` (default: today).

## scripts/generate.ts (rules JSON generator)

- `LAT`, `LON`, `TZ` - place for the sunset times.
- `ISRAEL`, `DEVICE_ID`, `START`, `YEARS`, `ENTRY`, `EXIT`, `REENTER`, `YOM_KIPPUR` - as above.
- `WEEKLY_RULES` - also emit the weekly Friday ON / Saturday OFF rule (`true`/`false`).
- `MODE` - `holiday` or `merged`.
- `OUT` - output path for the rules JSON.
- `CROSSCHECK` - set to `false` to skip the generated-rules cross-check (on by default).
- `SCHEDULE_MD` - also write an annotated Markdown schedule to this path (the Rules API has no comment field).

## scripts/collect.ts (read-only snapshot)

- `ST_TOKEN` - SmartThings token (required).
- `OUT_DIR` - where snapshots and events go; must be a PRIVATE location.
- `RETAIN_DAYS` - history retention (default 365).
- `LOCATION_ID`, `DEVICE_ID` - optional; auto-detected when exactly one.

## scripts/collect-encrypted.ts (encrypted collector)

- `ST_TOKEN` or `ST_TOKEN_FILE` - the token, inline or in a file.
- `STATE_FILE`, `STATE_KEY` - sealed OAuth state (read for the cursor only).
- `LOGS_PUBLIC_KEY_FILE` - recipient public-key file (default `config/logs.pub`).
- `CHUNK_DIR` - where `chunks/<random>.bin` is written.
- `CURSOR_OUT` - temp file for the next cursor (apply it with apply-cursor.ts after the chunk is pushed).

## scripts/collector-rotate.ts (token step)

- `STATE_FILE`, `STATE_KEY` - sealed OAuth state (the key is secret).
- `TOKEN_OUT` - file (mode 0600) the refreshed access token is written to.

## scripts/store.ts (git storage steps)

- `STATE_FILE` - state path (output on read-state, input on write-state).
- `STATE_SHA_FILE` - expected sha in, new sha out.
- `CHUNK_DIR` - write-logs reads `CHUNK_DIR/chunks/*.bin`.
- `GH_TOKEN` - the per-run github.token; reaches git only through its environment config.
- `STORE_REMOTE` is a test-only override, ignored inside GitHub Actions, and intentionally not operator configuration.

## scripts/analyze.ts / energy.ts (owner-side analysis)

- `SNAP_DIR` - where the snapshots live.
- `ENTRY`, `EXIT`, `REENTER`, `YOM_KIPPUR`, `ISRAEL` - rule parameters, as above.
- `TOL` - tolerance in minutes when matching door events to rules (default 15).
- `TZID` - timezone id for the energy report (default: the place in the newest snapshot).

## scripts/decrypt-logs.ts (owner-side, never CI)

- `LOGS_PRIVATE_KEY_FILE` - private key file (mode 0600, outside any git worktree).
- `LOGS_DIR` - checkout of the `logs` branch to decrypt.
- `OUT_DIR` - empty or new output folder, outside any worktree.

## scripts/oauth-setup.ts (one-time OAuth-In setup)

- `ST_PAT` - a token with app scopes, for `create-app` only.
- `STATE_FILE`, `STATE_KEY` - where the sealed state lives and its key.
- `REDIRECT_URI` - the app's redirect URI.
- `SCOPES` - `read` or `install`.
- `APP_NAME` - display name for the created app.
- `CODE` - the one-time code from the authorize redirect, for `exchange`.

## apply-cursor.ts / reseal-state.ts

- `STATE_FILE`, `STATE_KEY` - as above.
- `CURSOR_OUT` - the cursor file produced by collect-encrypted.ts.
- `NEW_STATE_KEY`, `OLD_STATE_KEY` - reseal the state under a new key while still reading the old one.
