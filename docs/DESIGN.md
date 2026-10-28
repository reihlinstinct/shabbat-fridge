# Design

Status: draft v0.1. Open questions are marked **OPEN**. Facts not yet checked against the user's real account or
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
4. Sunset offsets configurable. Defaults match the Samsung built-in: ON 10 min before sunset, OFF 40 min after.
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

### C. External scheduler calling the Devices API (optional safety layer)
Cron every 5 minutes computes whether "now" is inside a block, reads the fridge's Sabbath status, and sends a
command only when it differs. Useful if a rule fails to fire, but needs hosting and a long-lived OAuth app.
Defer until B is proven.

### D. SmartApp (webhook) or Edge driver
Edge drivers need a Hub; webhook SmartApp is C plus subscriptions. Not needed.

## 5. Components

- `core` (done): `computeBlocks(place, from, to, options)`.
- `rules` (done): `blocksToActions`, `buildRule`, `diffRules` with tests; JSON shape copied from the user's own rules.
- `smartthings` client (needed for install; read-only list/diff first): list locations and devices, read `samsungce.sabbathMode` status, send commands,
  token refresh.
- `reconciler`: pure function `(now, blocks, deviceState) -> command | none`, unit tested.
- `host`: Cloudflare Worker with a 5-minute Cron Trigger (free plan), state in free storage.
  Alternative: GitHub Actions cron (best effort timing, minutes of delay, auto-disabled after 60 days without
  repo activity). Cloudflare is preferred. **OPEN**: which account, see section 8.
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
4. Production OAuth app: he signs in to his Samsung/SmartThings developer access to authorize it.
5. Hosting account: use the existing free Cloudflare account or ask him to create one.
6. Yom Kippur on or off.
