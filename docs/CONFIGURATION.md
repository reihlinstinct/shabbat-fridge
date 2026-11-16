# Configuration reference

All environment variables the scripts read, grouped by script. Everything is
passed in the environment; no value is committed. Each section stands alone.

## scripts/install.ts (rule installer)

- `ST_TOKEN` - SmartThings personal access token (required; the run exits 2 without it).
- `DRY_RUN` - the run is a dry run unless `DRY_RUN=false`.
- `WEEKLY_RULES` - set to `true` to include the weekly Friday ON / Saturday OFF rule. While the dated-rules known issue (#63) is blocked, a run whose desired rule set would be empty exits with code 3 before any SmartThings call - so with the default `false` the installer refuses to run at all.
- `YEARS` - how many years ahead to install (default 10).
- `ENTRY`, `EXIT`, `REENTER` - minutes before sunset / after sunset / re-entry offset (defaults 60 / 90 / 100).
- `YOM_KIPPUR` - include the Yom Kippur rule (default `true`).
- `CALENDAR` - calendar mode: `israel`, `diaspora` or `auto` (default). When set it overrides `ISRAEL`; `auto` resolves from the SmartThings location country (ISR/IL) and fails with an error when the location has no country.
- `ISRAEL` - calendar override used only when `CALENDAR` is not set (`true`/`false`; default: auto from the location country).
- `LOCATION_ID`, `DEVICE_ID` - optional; auto-detected when the account has exactly one location / one sabbath-mode device, otherwise the run errors and lists the names.
- `CROSSCHECK` - cross-checks the computed Yom Tov days against the Hebcal web API (default on; set to `false` to skip). Skipped while the dated-rules known issue is blocked.
- `PRUNE` - default `false`. With `PRUNE=true` the plan may also remove previously managed dated yearly rules (`shabbat-fridge holidays YYYY`) that are absent from the desired set. Rules not managed by this tool are never touched.
- `START` - first day to cover, `YYYY-MM-DD` (default: today).

## scripts/generate.ts (rules JSON generator)

- `LAT`, `LON`, `TZ` - place for the sunset times (all required).
- `START` - first day to cover, `YYYY-MM-DD` (required).
- `OUT` - output path for the rules JSON (required).
- `YEARS` - how many years to generate (default 10).
- `ENTRY`, `EXIT`, `REENTER` - minutes before sunset / after sunset / re-entry offset (defaults 60 / 90 / 100).
- `ISRAEL` - Israel or Diaspora schedule (default `true`).
- `YOM_KIPPUR` - include the Yom Kippur rule (default `true`).
- `WEEKLY_RULES` - also emit the weekly Friday ON / Saturday OFF rule (default `false`).
- `MODE` - `holiday` (default) or `merged`.
- `DEVICE_ID` - device id embedded in the rule actions (required; the run fails without it).
- `CROSSCHECK` - cross-checks the computed Yom Tov days against the Hebcal web API (default on; set to `false` to skip).
- `SCHEDULE_MD` - optional path: also write an annotated Markdown schedule (the Rules API has no comment field).
- Known issue #63: dated holiday rules are blocked (`DATED_RULES_BLOCKED`). While blocked, the generator produces no dated blocks and skips the cross-check; a run that would only produce dated rules stops before reading anything else or writing a file.

## scripts/collect.ts (read-only snapshot)

- `ST_TOKEN` - SmartThings token (required). Only GET requests are made and the token is never printed or written.
- `OUT_DIR` - where snapshots and events go (required); must be a PRIVATE location (the files hold device and location ids, coordinates and door timing).
- `RETAIN_DAYS` - retention in days for snapshot files and monthly event files alike (default 365).
- `LOCATION_ID`, `DEVICE_ID` - optional; auto-detected when the account has exactly one.

## scripts/collect-encrypted.ts (encrypted collector)

- `ST_TOKEN` or `ST_TOKEN_FILE` - the token, inline or read from a file (one is required).
- `STATE_FILE`, `STATE_KEY` - sealed OAuth state, read for the cursor only (both required).
- `LOGS_PUBLIC_KEY_FILE` - recipient public-key file (default `config/logs.pub`).
- `CHUNK_DIR` - where `chunks/<random>.bin` is written (required).
- `CURSOR_OUT` - temp file for the next cursor (required); apply it with apply-cursor.ts after the chunk is pushed.

## scripts/collector-rotate.ts (token step)

- `STATE_FILE`, `STATE_KEY` - sealed OAuth state and its secret key (both required).
- `TOKEN_OUT` - file (mode 0600) the refreshed access token is written to (required).

## scripts/store.ts (git storage steps)

- `STATE_FILE` - state path: output on read-state, input on write-state (required).
- `STATE_SHA_FILE` - expected sha in, new sha out (required).
- `CHUNK_DIR` - write-logs reads `CHUNK_DIR/chunks/*.bin` (required for write-logs).
- `GH_TOKEN` - the per-run github.token; reaches git only through its environment config.
- `STORE_REMOTE` is a test-only override, ignored inside GitHub Actions, and intentionally not operator configuration.

## scripts/apply-cursor.ts

- `CURSOR_OUT` - the cursor file produced by collect-encrypted.ts (required).
- `STATE_FILE`, `STATE_KEY` - the sealed state to apply the cursor to (both required).

## scripts/reseal-state.ts

- `STATE_FILE` - the sealed state file (required).
- `OLD_STATE_KEY` - key the state is currently sealed with (required).
- `NEW_STATE_KEY` - key to reseal it under (required).

## scripts/analyze.ts (owner-side analysis)

- `SNAP_DIR` - where the snapshots live (required); the place and window come from the snapshots themselves.
- `ISRAEL` - calendar override (default: from the newest snapshot's country).
- `ENTRY`, `EXIT`, `REENTER` - rule window offsets in minutes (defaults 60 / 90 / 100).
- `YOM_KIPPUR` - include the Yom Kippur rule in the reconstruction (default `true`).
- `TOL` - tolerance in minutes when matching door events to rules (default 15).

## scripts/energy.ts (owner-side, never CI)

- `SNAP_DIR` - where the snapshots live (required).
- `TZID` - timezone id for the report (default: the newest snapshot's place, else UTC).

## scripts/decrypt-logs.ts (owner-side, never CI)

- `LOGS_PRIVATE_KEY_FILE` - private key file, mode 0600, outside any git worktree (required for keygen and decrypt).
- `LOGS_DIR` - checkout of the `logs` branch to decrypt (required for decrypt).
- `OUT_DIR` - empty or new output folder, outside any worktree (required for decrypt).

## scripts/oauth-setup.ts (one-time OAuth-In setup)

- `ST_PAT` - a token with app scopes (required for create-app).
- `STATE_FILE` - where the sealed state lives (default `state/oauth.enc.json`).
- `STATE_KEY` - the state encryption key (required).
- `REDIRECT_URI` - the app's redirect URI (required).
- `SCOPES` - `read` (default) or `install`.
- `APP_NAME` - display name for the created app (default `shabbat-fridge`).
- `CODE` - the one-time code from the authorize redirect (required for exchange).
