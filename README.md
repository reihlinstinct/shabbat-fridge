# shabbat-fridge

Sets Shabbat / Yom Tov mode on Samsung SmartThings appliances (first target: a Samsung fridge) from the
Jewish calendar and local sunset, instead of relying on the appliance's built-in weekly Shabbat timer.

**Status: design phase.** The code computes and diffs rules; nothing here writes to SmartThings yet. See
[docs/DESIGN.md](docs/DESIGN.md) and [docs/RESEARCH.md](docs/RESEARCH.md).

## The problem

The fridge's built-in Shabbat mode runs weekly, around sunset. It does not know about Yom Tov, and a Yom Tov
that touches Shabbat can take the fridge out of the mode in the middle of the holiday.

## Known issue: dated holiday rules are paused / בעיה ידועה

Dated holiday rules appear to fire every day on SmartThings instead of only on their date (see [issue #63](https://github.com/reihlinstinct/shabbat-fridge/issues/63), SmartThings ticket 1629394). Until that is resolved, `scripts/install.ts` and `scripts/generate.ts` create no dated rules:

- A run that asks only for dated rules stops at once with exit code 3 and a message linking the issue. Nothing is created, changed or deleted.
- The weekly Shabbat rule (Friday ON, Saturday OFF) is not dated and still works: set `WEEKLY_RULES=true` (workflow input `weekly_rules`). The run installs only that rule and prints a one-line notice that dated rules were skipped.
- If dated "shabbat-fridge holidays" rules already exist in the account, the install run warns and leaves them alone. Delete them in SmartThings.

כללי חג עם תאריך נראים כנורים כל יום ב-SmartThings ולכן מושבתים. כלל השבת השבועי (כניסה בשישי, יציאה במוצאי שבת) ממשיך לעבוד עם `WEEKLY_RULES=true`.

## What exists today

`src/blocks.ts` computes the "no-touch" blocks for any location:

- Shabbat plus Yom Tov days, merged when adjacent (Yom Tov next to Shabbat is one block).
- Israel calendar (one day of Yom Tov) or Diaspora (two days), a setting of the place.
- Latitude, longitude and time zone are inputs. Nothing is hardcoded to Jerusalem.
- Entry (default 10 min before sunset) and exit (default 40 min after sunset) are options.

```
npm ci
npm test
npm run typecheck
```

[docs/INSTALL-WORKFLOW.md](docs/INSTALL-WORKFLOW.md) explains the GitHub Actions installer (dry run first, token as a repo secret).

Every workflow except the protected `collector.yml` and `keepalive.yml` ends with a `Run summary` job that writes a summary to the top of the run page: which jobs ran, their result and duration, what was skipped and why, the commits and files the run changed, and which checks cover those changes (`.github/ci-coverage-map.json` declares the coverage; files matching no mapping are flagged). The script is `scripts/ci/run_summary.py`.

`scripts/generate.ts` writes the Rules JSON from environment settings (no private data in the repo).

`src/rules.ts` turns blocks into dated, Sunset-relative SmartThings Rules actions and diffs them against existing rules (dry run).

Calendar and sunset data come from [@hebcal/core](https://github.com/hebcal/hebcal-es6) and run fully offline.

## Disclaimer

Not a halachic authority. Defaults (Yom Kippur, offsets) are settings. Confirm with your own rabbi.

License: MIT.

Note: the holiday re-ON (+100 min on a Saturday before a holiday) assumes the weekly Saturday OFF fires at +90 or earlier. See docs/INSTALL-WORKFLOW.md.

Optional: both workflows can also manage a weekly Shabbat rule (`weekly_rules`, off by default). See docs/INSTALL-WORKFLOW.md.
Optional: read-only snapshot collector and analyzer for post-incident analysis (private storage only). See docs/FORENSICS.md.
Optional: hourly collector in this repository with encrypted logs (`collector` workflow, `logs` and `state` branches, `scripts/decrypt-logs.ts` for the owner). Design: docs/ENCRYPTED-LOGS.md and docs/ENCRYPTED-LOGS-COLLECTOR.md. It stays inactive unless the repository variable COLLECTOR_ENABLED is `true`, and needs the setup described there (public key in config/logs.pub, `collector` Environment with STATE_KEY).
Unattended token rotation and yearly installer: see docs/UNATTENDED.md.
