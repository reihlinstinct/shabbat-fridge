# Design

Status: draft v0.2. Open questions are marked **OPEN**. Facts not yet checked against the user's real account or
fridge are marked **UNVERIFIED**. Sources are in [RESEARCH.md](RESEARCH.md).

## 1. Goal

Turn the fridge's Sabbath mode ON before every Shabbat and Yom Tov and OFF only when the whole run of holy days
ends, using the real local sunset of the place where the fridge is. No hardcoded city.

## 2. Requirements

1. Correct calendar: Shabbat, Yom Tov days, merged when adjacent.
2. Israel (1 day) or Diaspora (2 days) chosen from the location, overridable.
3. Location selectable. Preferred source: the SmartThings Location that holds the device (latitude,
   longitude, time zone, country as ISO alpha-3, e.g. ISR). Verified on the user's account: `GET /locations/{id}`
   returns them (the list endpoint returned nulls). Manual override always available.
4. Sunset offsets configurable. The user chose to keep his current values: ON 60 min before sunset, OFF 90 min after, Yom Kippur included (2026-10-28). Library defaults (10/40) mirror the Samsung built-in.
5. Free hosting, no payment, no personal data in the repo.
6. Honest about failure: if the fridge refuses the command we say so, we do not pretend.
7. Tested against known dates (section 6).

## 3. Calendar rules (what a "block" is)

A block is a maximal run of consecutive local days that are Shabbat or Yom Tov.

- Start: sunset of the day before the first day, minus the entry offset.
- End: sunset of the last day, plus the exit offset.
- Days: every Saturday, plus Yom Tov days from the calendar library for the chosen calendar.
- Israel: Rosh Hashana 2 days, Yom Kippur 1, Sukkot day 1, Shmini Atzeret (includes Simchat Torah) 1,
  Pesach day 1 and day 7, Shavuot 1. Diaspora adds the second days.
- Not block days: Chol HaMoed, Hoshana Rabba (it is an erev chag only), Purim, Chanukah, fasts.
- Yom Kippur: included by default, setting `includeYomKippur`. **OPEN**: user to confirm.
- Merging means Yom Tov on Sunday, Friday, or any adjacency produces one block. This is the fix for the
  bug the user sees with the built-in timer. Implemented in `src/blocks.ts`, covered by tests.
- Sunset uses the location's own time zone and the library's solar calculation. DST is handled by working
  in instants, not wall-clock arithmetic (tested for Israel 2027-03-26).
- Hebrew date conventions: this project only needs the library's holiday days. If we ever convert
  user-supplied dates we follow the user's rules in his Hebrew-date preferences (Adar II, 30th of a short month).
  Not needed in v1.

Edge cases to cover later: Shabbat that begins at Shabbat sunset in far-north latitudes (library warns above the
polar circle), a user in the Diaspora with an Israeli-style one-day observance (override), travel (location
changes between runs: recompute on every run).

## 4. Architecture options

Finding from a read-only check of the user's real SmartThings account (2026-10-28): the fridge exposes
`samsungce.sabbathMode` (on/off), its SmartThings Location has country, time zone and coordinates, and the user
already runs three Rules on it. Those rules prove (a) the Rules API accepts dated `every` entries
(`year`, `month`, `day`, `reference: Sunset`, minute offset) and (b) a cloud "off" command reached the fridge
at the scheduled time (status changed at the rule's Saturday sunset+90 minutes). This corrects an earlier
assumption that Rules are weekday-only.

### What can run on Samsung's servers (checked 2026-10-28, sources in RESEARCH.md)

The user asked for this to be built into SmartThings and to run on Samsung's servers. Honest answer:

| Option | Runs where | Can it do this job? |
| --- | --- | --- |
| Routines (app UI) | Samsung cloud | No. Conditions are times, weekdays, device states, presence. No Hebrew calendar, no holidays by date range. |
| Rules API (`every` + `specific` date + Sunset) | Samsung cloud (or Hub when all devices are local) | Yes, for fixed dates. It is the only logic that executes on Samsung's servers, so dated rules are effectively the built-in way. It has no Hebrew-calendar knowledge: we compute the dates and hand them over. |
| Edge drivers (Lua) | The user's SmartThings Hub, locally | No for this fridge. Edge targets Matter, Zigbee, Z-Wave and LAN devices on a Hub; the fridge is a cloud-connected Samsung device. Needs a Hub, which is unconfirmed. |
| Schema connector (cloud-to-cloud) | Developer-hosted AWS Lambda or webhook | Not Samsung-hosted. Doable (a community project "Shabbat Switch" does this, see RESEARCH.md) but adds a third-party host. |
| Webhook SmartApp / OAuth integration | Developer-hosted | Not Samsung-hosted. |
| Groovy SmartApps (the old Samsung-hosted code) | Was Samsung cloud | Shut down 31 Dec 2022. |
| Developer Workspace cloud projects | Was Samsung tooling | Cloud-connected projects ended in Developer Workspace on 5 Aug 2025 (moved to the Developer Center, still developer-hosted). |

No Samsung-hosted runtime for third-party logic was found. So the only no-host design is dated Rules.

### Long-horizon dated Rules (B1): zero hosting, Samsung executes
Dates in the Hebrew calendar are pure arithmetic, so we can generate many years at once. Install as many years as
the Rules guardrails allow (to measure: actions per rule, rules per location), for example 5 to 10 years, split
into one rule per quarter or year. SmartThings then runs everything, including the Sunset math, with nothing of
ours alive. Renewal is a one-off job every N years (a calendar reminder, or the optional weekly service below).
Limits to state plainly: it covers only the generated horizon, and a changed location (moving house) needs the rules
regenerated because offsets follow the SmartThings Location's sunset.

Updated recommendation: install B1 now for the longest horizon the guardrails allow. Keep the weekly Cloudflare
service (B2) as an optional extension for "automatic forever", since it only adds rules and nothing breaks if it
stops. Decision order: measure limits, install B1, then decide if B2 is worth the OAuth setup.

### A. SmartThings Routines (native, no code)
The Routines UI does not expose the Sabbath capability (community report). Rejected.

### B. Generated SmartThings Rules (recommended primary)
`computeBlocks` produces the holy-day blocks. `blocksToActions` turns each into two dated, Sunset-relative
actions: ON on the eve of the first day (sunset minus entry), OFF on the last day (sunset plus exit). Adjacent
Shabbat and Yom Tov days are one block, so there is no OFF between them. The Rules engine resolves "Sunset"
for the SmartThings Location, which is why the location in SmartThings must be right (country, time zone,
coordinates are set on the user's account). Runs on SmartThings, with no hosting of ours, no keep-alive, and it
keeps working if our service is down. Rules built this way can only be edited by the account owner and
installed with a token that has rules write access.

Open details: maximum actions per rule, how far ahead to generate (a year at a time, renewed before it runs out),
and replacing the user's current weekly rules (a weekly OFF fires every Saturday and ends a Saturday+Sunday
holiday early; the weekly ON/OFF pair becomes redundant once dated actions cover Shabbat too).

Dry run: `diffRules(existing, desired, deviceId)` lists what is missing, what is extra, and which weekly rules
exist. It reads data only and sends nothing.

### C. External scheduler that reconciles the fridge every few minutes
A hosted cron (Cloudflare Workers, free) computes whether "now" is inside a block, reads the fridge's Sabbath
status, and sends a command only when it differs.

### B vs C for "works automatically in all future years"

The user wants no yearly chore. Both options need a free host and a SmartThings OAuth app (PATs last 24 hours).
They differ in what must stay alive.

| | B2: service keeps dated Rules rolled forward | C: service sends every command |
| --- | --- | --- |
| Who runs ON/OFF | SmartThings itself, from installed Rules | Our service, every 5 min |
| If our host or OAuth breaks | Fridge keeps working until the last installed date (about 12 months buffer) | Next Shabbat is missed. A failed ON before candle lighting cannot be fixed during Shabbat |
| Service must run | About once a week (extend horizon) | Every 5 minutes, all year, around candle lighting |
| Free-tier fit | Trivial (a few API calls a week) | About 8,600 invocations a month, within 100,000 per day, but a tighter dependency |
| Time precision | SmartThings Sunset engine, same as today's rules | Our own sunset math, polled in 5 minute steps |
| Visibility to user | Rules visible in the SmartThings app, can be disabled there | Invisible logic in our host |
| Risk | Rule limits (actions per rule, rules per location) unknown | Needs Samsung cloud and our cloud both up at Shabbat entry |

Decision: B2 as the primary. The service is a weekly "make sure the next 12 months of dated Rules exist"
job. It owns only rules whose names start with `shabbat-fridge` and never edits the user's other rules. It
diffs desired and existing actions (`diffRules`), adds missing ones, and prunes dates in the past. Each run is
idempotent, so missed weeks are harmless. C stays available as a verify-only watchdog later (Friday afternoon:
read the status and the installed rules, alert if ON is not scheduled).

Why this survives the token problem: refresh tokens are single-use, and an unused refresh token may expire
(lifetime **UNVERIFIED**, not stated on the token-management page). A weekly run keeps the chain alive, and if the
service dies the installed rules still cover the buffer. Storage for the rotating token: one record that only
the weekly job writes, so Workers KV free tier (1 write/sec per key, 1,000 writes/day) is enough. The write
must be done before the new access token is used.

Interim: before the service exists, install the first 12 months of rules by hand with a 24 hour token. It gives
value now, and the service later extends the same rules.

Open: Rules guardrails (actions per rule, rules per location) are not on the public rate-limit page we found;
measure by installing a test rule. Group actions into one rule per quarter until measured.

### D. SmartApp (webhook) or Edge driver
Edge drivers need a Hub; webhook SmartApp is C plus subscriptions. Not needed.

## 5. Components

- `core` (done): `computeBlocks(place, from, to, options)`.
- `rules` (done): `blocksToActions`, `buildRule`, `diffRules` with tests; JSON shape copied from the user's own rules.
- `smartthings` client (needed for install; read-only list/diff first): list locations and devices, read `samsungce.sabbathMode` status, send commands,
  token refresh.
- `planner`: pure function from (today, place, settings, existing managed rules) to the rules to add and the past entries to remove; built on `computeBlocks` and `diffRules`, unit tested.
- `watchdog` (later, optional): read-only Friday check that ON is scheduled.
- `host`: Cloudflare Worker with a weekly Cron Trigger (free plan) that extends the rolling 12 month horizon; token record in Workers KV.
  Alternative: GitHub Actions weekly cron (fine for a weekly job, but auto-disabled after 60 days without repo
  activity and it cannot store a rotating token safely without a PAT). Cloudflare is preferred. **OPEN**: which account, see section 8.
- Config: place (auto from SmartThings Location or manual), offsets, Yom Kippur, device selection.
- Status page / notification: later.

Authentication: SmartThings personal access tokens issued now last 24 hours, so they are only for testing.
Generated Rules keep running after the token expires, so a PAT is enough to install a year of rules, and renewal
is a once-a-year task. A fully automatic renewal needs an OAuth app (OAuth-In, API-only) with refresh tokens. Refresh tokens are single-use, so token
storage must be updated atomically each refresh. **UNVERIFIED**: exact app-creation steps for a plain Samsung
account today.

## 6. Test plan

Known-date fixtures (already in `test/blocks.test.ts`, Jerusalem unless noted):

| Case | Expectation |
| --- | --- |
| Plain Shabbat 2026-10-10 | ON Fri sunset-10, OFF Sat sunset+40 |
| Rosh Hashana 5787 (Sat+Sun 2026-09-12/13) | one block, no drop Saturday night |
| Hoshana Raba Fri 2026-10-02 (last day of Chol HaMoed, eve of Shmini Atzeret) | not a block day; the block for 10-03 starts at its sunset |
| Sukkot V 2026-09-30 | Chol HaMoed, no block |
| Shmini Atzeret 2026-10-03 | Israel: 1 day. Diaspora: 2 days (10-03, 10-04) |
| Shavuot Fri 2027-06-11 + Shabbat | one block |
| Pesach I Thu 2027-04-22 | block starts Wed evening |
| Yom Kippur | excluded with option off |
| New York, Dec 2026 | local sunset and time zone |
| Israel DST 2027-03-26 and 2026-10-25; New York 2026-11-01 | offsets exact in instants |
| Diaspora Pesach 2027 Thu-Fri-Sat | one three-day block; Israel splits it |
| Jerusalem entry times vs Hebcal published candle lighting (b=10) | equal to the minute |

To add: cross-check every block for 5 years against Hebcal's published Israel candle-lighting and Havdalah list
as an independent oracle; reconciler tests (missed tick, manual toggle, fridge offline); client tests with
recorded SmartThings responses; an end-to-end dry run that logs commands without sending them.

## 7. Honest limits

- **Capability may be blocked** (not on the user's fridge: the capability is listed and a cloud off arrived). Reports exist of Samsung returning NOT_FOUND/422 for `samsungce.sabbathMode`
  on some models (Dacor cases) even when listed, and of it working on others. Only a test on the user's fridge
  settles it.
- Evidence that cloud OFF works while in the mode: the user's Saturday rule turned it off. Cloud ON has not been
  observed by us; the user's rules use it, to be confirmed from status history.
- The built-in weekly timer may still run. If it cannot be turned off, it will flip the mode off Saturday night
  in the middle of a Sat+Sun holiday; the reconciler would turn it back on within 5 minutes. A short gap is
  possible. **OPEN**: is there a setting to disable the built-in timer?
- A service that sends `on` before Shabbat depends on internet, Samsung cloud and our host being up. A failed
  `on` cannot be fixed during Shabbat. Mitigation: send `on` early (configurable lead), verify status, retry,
  alert before candle lighting if it is not confirmed.
- This is a scheduling aid, not a halachic ruling.

## 8. Decisions and access needed from the user

1. Fridge model, and does SmartThings show Menu > Refrigerator options > Sabbath mode?
2. A read-only test: he creates a 24-hour SmartThings token (read devices, read locations) so we can list the
   device, its capabilities, the Location coordinates and country. No commands sent. Token via a vault link.
3. A one-time write test on a weekday (ON for 2 minutes, then OFF) with his go-ahead at the fridge.
4. Production OAuth app (needed for automatic yearly extension): he authorizes it once with his Samsung account.
   Interim: a 24 hour token with Rules write for a first 12 month install.
5. Hosting account: use the existing free Cloudflare account or ask him to create one.
6. Yom Kippur on or off.
