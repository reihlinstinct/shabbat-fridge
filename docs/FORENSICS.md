# Post-incident analysis: fridge snapshots / ניתוח תקלות

**Goal:** if the fridge leaves Sabbath mode when it should not, have the evidence. / אם המקרר יוצא ממצב שבת, צריך ראיות.

## What SmartThings keeps (verified against a live account, 2026-10-28)
- Device event history (`GET /v1/history/devices?locationId=&deviceId=`, undocumented in the official reference) keeps about 7 days. For a Samsung fridge it held
  only door contact events: **no Sabbath-mode changes**.
- The device status of `samsungce.sabbathMode` holds the current value **and the time of its last change**. That is the only trace of mode changes.
- A rule's `dateExecuted` tells when it last fired. It is not a log.
- The SmartThings app History tab shows more (including what triggered an event) but has no API.

So the only way to keep a change log is to **read the status regularly and store it**. A change that is overwritten between two snapshots is lost;
the analyzer prints the largest gap. A 30-minute interval is the practical floor on GitHub Actions (scheduled runs can be late or skipped).

## Privacy rule
Snapshots hold device and location ids, coordinates, door timing (home occupancy) and rule names. They go **only** to a private repository
(`reihlinstinct/shabbat-fridge-logs`) or a private folder, never to this public repo. This repo holds code and tests only.
The analyzer's `Summary:` line (counts per finding kind) is safe to share publicly; its table lists calendar dates and minutes only.

## Tools
- `scripts/collect.ts` (read-only, GET only): writes `snapshots/YYYY-MM/<time>.json` (status, rules summary, place) and appends new history events to
  `events/YYYY-MM.ndjson`. `RETAIN_DAYS` (default 365) deletes old snapshots. The token is never printed or written.
  `ST_TOKEN=... OUT_DIR=/private/dir npx tsx scripts/collect.ts`
- `scripts/analyze.ts`: compares the observed changes with the scheduled blocks (ON at sunset - 60, OFF at sunset + 90 by default, holidays included; location from the snapshot).
  Findings: `ok`, `missed-on`, `early-exit` (off inside the block, with minutes before the scheduled end), `late-exit`, `unexplained-on`, `not-covered`.
  `SNAP_DIR=/private/dir npx tsx scripts/analyze.ts`
- `docs/forensics/collect.yml`: workflow template for the private repo (every 30 minutes and on demand).

## Retention and Git history
`RETAIN_DAYS` (a positive number, default 365) deletes snapshots older than that by their own `takenAt`, and event files whose whole month is older, from the working tree.
**Git history keeps deleted files.** To really purge old data, recreate the private repo or rewrite its history. The template workflow only deletes in the working tree.

## Safety of the workflow template
It fails closed before any secret is used: the repository must be exactly `reihlinstinct/shabbat-fridge-logs` and the GitHub API must report it private, and `TOOL_REF` must be a 40-character commit SHA you reviewed (the placeholder fails the run).
Dependencies come from the lockfile (`npm ci --ignore-scripts`), and `tsx` is a locked dev dependency run with `npx --no-install`, so nothing is downloaded while the token is in the environment.

## Analyzer model
The analyzer knows the holiday companion design: on a Saturday inside a holiday block, the weekly OFF at +90 and the re-ON at +100 are an expected 10-minute gap, not an early exit. A missing re-ON is reported as `missed-reon`.

## Limits
- A SmartThings personal token lasts 24 hours, so a scheduled run needs a fresh secret every day. A long-lived credential needs an OAuth app; its refresh-token lifetime is unverified here.
  Without one, run the collector on demand (token plus "Run workflow") right after an incident: the history still holds the last 7 days and the status shows the last change time.
- The analyzer assumes the offsets you give it (`ENTRY`, `EXIT`). It cannot tell why a change happened, only when it did and whether the schedule predicts it.
- The fridge's own Shabbat timer or a manual change look the same as a rule in the status.
