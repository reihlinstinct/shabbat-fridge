# Research notes (2026-10-28)

All links were read on 2026-10-28. "Community" means forum posts, not official guarantees.

## SmartThings and the fridge capability

- Capability `samsungce.sabbathMode` with commands `on` / `off` exists. Home Assistant added it as a switch
  (status attribute). Example Rules JSON that commands it, plus a Sunset-based weekly rule, is in the community
  thread: https://community.smartthings.com/t/sabbath-mode-to-be-added-to-routines-update/279681
- A community developer reports the capability is not exposed to Routines at all, and that Samsung disables it
  server-side on some models (Dacor), returning NOT_FOUND/422 although listed. Another reply confirms a
  Samsung RF85R9141SR works through the API.
  https://community.smartthings.com/t/free-integration-automate-shabbat-trying-to-unlock-samsung-fridge-sabbath-mode-via-api-looking-for-testers/310577
- Samsung support: not all models have Sabbath mode; where present and SmartThings-enabled it is under
  Refrigerator options > Sabbath mode. https://www.samsung.com/us/support/answer/ANS10006799/

## Rules, schedules, hubs

- Rules API: JSON actions (`if`, `sleep`, `command`, `every`) and operand `specific` with references such as
  Noon and a minute offset. Rules run locally on a Hub when possible, else in the cloud. A rule installed by an
  owner can only be edited by that owner. https://developer.smartthings.com/docs/automations/rules
- Rules samples: https://github.com/SmartThingsDevelopers/Sample-RulesAPI/blob/master/README.md
- The community example uses `daysOfWeek` + `Sunset` + offset. The Rules API also accepts `year`, `month`, `day`
  in `specific` (seen in the user's own rule, 2026-10-28), so dated Sunset-relative actions work.

## Auth and integration style

- Personal access tokens issued since 30 Dec (2024) live 24 hours; use OAuth for anything long-lived.
  https://community.smartthings.com/t/changes-to-personal-access-tokens-pat/292019/
- OAuth access tokens last about 24h; refresh tokens are single-use, so store both new tokens after each refresh.
  https://developer.smartthings.com/docs/service-integrations/token-management
- Webhook events are signed (HTTP signature, digest, date).
  https://developer.smartthings.com/docs/service-integrations/webhook-events
- Architecture overview: https://developer.smartthings.com/docs/getting-started/architecture-of-smartthings
- Public API reference: https://developer.smartthings.com/docs/api/public

## Jewish calendar and sunset

- `@hebcal/core` computes holidays (Israel flag `il`) and zmanim offline for any latitude, longitude, time zone.
  Its own defaults: candle lighting 18 min before sunset (40 in Jerusalem), Havdalah at 8.5 degrees. We override
  with fixed minute offsets from sunset because that matches the fridge.
  https://hebcal.github.io/api/core/functions/calendar.html
- Hebcal web API location options (GeoNames id, lat/long+tz): https://www.hebcal.com/home/4912/specifying-a-location-for-jewish-calendar-apis
  Useful later as an independent oracle in tests.

## Hosting on free tiers

- Cloudflare Workers Free: 100,000 requests/day, 10 ms CPU per invocation; Cron Triggers fit a 5-minute loop.
  https://developers.cloudflare.com/workers/platform/pricing/ (check KV/Durable Object free limits before building)
- GitHub Actions `schedule`: default branch only, delayed not exact; public repos' schedules are disabled after
  60 days without activity. https://latchkey.dev/learn/github-actions/github-actions-schedule-disabled-60-days-inactivity

## Not yet verified

- Whether this fridge accepts `on`/`off` through the API and still accepts `off` while the mode is on.
- Whether the built-in Shabbat timer can be disabled.
- Exact OAuth app creation flow today for a personal account.
