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
   longitude, time zone, country). Manual override always available. **UNVERIFIED**: field names and that the
   fridge's Location is set correctly in the user's account.
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

### A. SmartThings Routines (native, no code)
Routines UI does not expose the Sabbath capability (community report). Weekly only, so it cannot know Yom Tov.
Rejected as the whole solution. Could stay as a weekly safety net.

### B. SmartThings Rules API
Rules can run on a schedule with a Sunset reference and offset, and can command a device capability
(`samsungce.sabbathMode`, commands `on`/`off`) per community examples. But a schedule rule fires by weekday, not
by calendar date, so it cannot place Yom Tov. Rules also cannot be edited by us after the owner installs them.
Possible role: Friday safety net. Not enough alone.

### C. External scheduler calling the SmartThings Devices API (recommended)
A tiny service computes blocks with the library and sends `on` / `off` to the fridge through the Devices API.

Reconcile loop, not one-shot timers: a cron fires every 5 minutes, computes whether "now" is inside a block,
reads the fridge's current Sabbath status, and sends a command only if it differs. A missed or late cron
self-heals on the next tick. It also handles a human or the built-in timer flipping the mode (see 5).

### D. SmartApp (webhook) or Edge driver
Edge drivers run on a Hub; the fridge is a cloud device and we have no Hub requirement. A webhook SmartApp is the
same as C plus subscriptions and a public HTTPS endpoint. C only needs outbound calls. Start with C.

## 5. Components (option C)

- `core` (done): `computeBlocks(place, from, to, options)`.
- `smartthings` client: list locations and devices, read `samsungce.sabbathMode` status, send commands,
  token refresh.
- `reconciler`: pure function `(now, blocks, deviceState) -> command | none`, unit tested.
- `host`: Cloudflare Worker with a 5-minute Cron Trigger (free plan), state in free storage.
  Alternative: GitHub Actions cron (best effort timing, minutes of delay, auto-disabled after 60 days without
  repo activity). Cloudflare is preferred. **OPEN**: which account, see section 8.
- Config: place (auto from SmartThings Location or manual), offsets, Yom Kippur, device selection.
- Status page / notification: later.

Authentication: SmartThings personal access tokens issued now last 24 hours, so they are only for testing.
Production needs an OAuth app (OAuth-In, API-only) with refresh tokens. Refresh tokens are single-use, so token
storage must be updated atomically each refresh. **UNVERIFIED**: exact app-creation steps for a plain Samsung
account today.

## 6. Test plan

Known-date fixtures (already in `test/blocks.test.ts`, Jerusalem unless noted):

| Case | Expectation |
| --- | --- |
| Plain Shabbat 2026-10-10 | ON Fri sunset-10, OFF Sat sunset+40 |
| Rosh Hashana 5787 (Sat+Sun 2026-09-12/13) | one block, no drop Saturday night |
| Hoshana Rabba 2026-09-30 | no block |
| Shmini Atzeret 2026-10-03 | Israel: 1 day. Diaspora: 2 days (10-03, 10-04) |
| Shavuot Fri 2027-06-11 + Shabbat | one block |
| Pesach I Thu 2027-04-22 | block starts Wed evening |
| Yom Kippur | excluded with option off |
| New York, Dec 2026 | local sunset and time zone |
| Israel DST 2027-03-26 | offsets exact in instants |

To add: cross-check every block for 5 years against Hebcal's published Israel candle-lighting and Havdalah list
as an independent oracle; reconciler tests (missed tick, manual toggle, fridge offline); client tests with
recorded SmartThings responses; an end-to-end dry run that logs commands without sending them.

## 7. Honest limits

- **Capability may be blocked.** Reports exist of Samsung returning NOT_FOUND/422 for `samsungce.sabbathMode`
  on some models (Dacor cases) even when listed, and of it working on others. Only a test on the user's fridge
  settles it.
- If Sabbath mode on this fridge disables cloud control while it is ON, the OFF command may never arrive.
  **UNVERIFIED**: we must test ON then OFF on a weekday.
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
