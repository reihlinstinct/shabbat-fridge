/**
 * Install or update the "shabbat-fridge holidays YYYY" rules in SmartThings. Dry run unless DRY_RUN=false.
 * Env: ST_TOKEN (required), DRY_RUN=true, YEARS=10, ENTRY=60, EXIT=90, REENTER=100, YOM_KIPPUR=true,
 *      LOCATION_ID, DEVICE_ID (optional; auto-detected when exactly one), ISRAEL=true|false (optional override),
 *      PRUNE=false, START=YYYY-MM-DD (default today).
 * Never prints the token or any API response body. Only rules named "shabbat-fridge holidays YYYY" are touched.
 */
import { appendFileSync } from 'node:fs';
import { computeBlocks, type Place } from '../src/blocks.js';
import { isEmpty, planInstall, resolveIsrael, type ExistingRule } from '../src/install.js';
import { crossCheckOrThrow } from '../src/crosscheck.js';
import { holidayOnlyActions, rulesByYear } from '../src/rules.js';
import { SmartThings, sabbathDevices } from '../src/smartthings.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const token = env('ST_TOKEN').trim();
if (!token) {
  console.error('ST_TOKEN is empty. Set the SMARTTHINGS_TOKEN repository secret.');
  process.exit(2);
}
const dry = env('DRY_RUN', 'true') !== 'false';
const log: string[] = [];
const say = (s: string): void => {
  console.log(s);
  log.push(s);
};

const st = new SmartThings(token);
const locs = await st.locations();
const locationId = env('LOCATION_ID') || (locs.length === 1 ? locs[0]!.locationId : '');
if (!locationId) throw new Error(`Found ${locs.length} locations; set LOCATION_ID (names: ${locs.map((l) => l.name).join(', ')})`);
const loc = await st.location(locationId);
const fridges = sabbathDevices(await st.devices(), locationId);
const deviceId = env('DEVICE_ID') || (fridges.length === 1 ? fridges[0]!.deviceId : '');
if (!deviceId) throw new Error(`Found ${fridges.length} devices with ${'samsungce.sabbathMode'}; set DEVICE_ID`);
if (loc.latitude == null || loc.longitude == null || !loc.timeZoneId) throw new Error('The SmartThings Location has no coordinates or time zone; set them in the SmartThings app');
const israel = process.env.CALENDAR ? resolveIsrael(process.env.CALENDAR, loc.countryCode) : env('ISRAEL') ? env('ISRAEL') === 'true' : resolveIsrael('auto', loc.countryCode);
const place: Place = { latitude: loc.latitude, longitude: loc.longitude, tzid: loc.timeZoneId, israel };

const startStr = env('START') || new Date().toISOString().slice(0, 10);
const [y, m, d] = startStr.split('-').map(Number) as [number, number, number];
const start = new Date(y, m - 1, d);
const end = new Date(y + Number(env('YEARS', '10')), m - 1, d);
const entry = Number(env('ENTRY', '60'));
const exit = Number(env('EXIT', '90'));
const blocks = computeBlocks(place, start, end, { entryMinutesBeforeSunset: entry, exitMinutesAfterSunset: exit, includeYomKippur: env('YOM_KIPPUR', 'true') === 'true' });
if (env('CROSSCHECK', 'true') !== 'false') {
  const n = await crossCheckOrThrow(blocks, israel, startStr, `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`, env('YOM_KIPPUR', 'true') === 'true');
  say(`Cross-check: ${n} Yom Tov days match the Hebcal web API`);
}
const actions = holidayOnlyActions(blocks, { deviceId, entryMinutesBeforeSunset: entry, exitMinutesAfterSunset: exit, reenterMinutesAfterSunset: Number(env('REENTER', '100')) });
const desired = rulesByYear('shabbat-fridge holidays', actions);

const existing: ExistingRule[] = [];
for (const s of await st.rules(locationId)) existing.push(await st.rule(locationId, s.id));
const plan = planInstall(existing, desired, env('PRUNE') === 'true');

say(`Calendar: ${israel ? 'Israel' : 'Diaspora'}, time zone ${place.tzid}, window ${startStr} + ${env('YEARS', '10')} years, offsets ${-entry}/+${exit}/+${env('REENTER', '100')} min`);
say(`Desired: ${desired.length} rules, ${actions.length} actions. Existing rules left alone: ${plan.untouched.length}`);
say(`Plan: create ${plan.create.length}, update ${plan.update.length}, remove ${plan.remove.length}, unchanged ${plan.unchanged.length}`);
for (const r of plan.create) say(`  create ${r.name} (${r.actions.length} actions)`);
for (const u of plan.update) say(`  update ${u.rule.name} (${u.rule.actions.length} actions)`);
for (const r of plan.remove) say(`  remove ${r.name}`);

if (dry) say('Dry run: nothing was written. Re-run with dry_run=false to apply.');
else if (isEmpty(plan)) say('Nothing to do.');
else {
  for (const r of plan.create) await st.createRule(locationId, r);
  for (const u of plan.update) await st.updateRule(locationId, u.id, u.rule);
  for (const r of plan.remove) await st.deleteRule(locationId, r.id);
  const after: ExistingRule[] = [];
  for (const s of await st.rules(locationId)) after.push(await st.rule(locationId, s.id));
  const again = planInstall(after, desired, env('PRUNE') === 'true');
  const untouchedSame = existing.filter((e) => !/^shabbat-fridge holidays \d{4}$/.test(e.name)).every((e) => {
    const a = after.find((x) => x.id === e.id);
    return a && JSON.stringify(a.actions) === JSON.stringify(e.actions);
  });
  say(`Verify: ${isEmpty(again) ? 'rules match the plan' : 'MISMATCH, re-run dry run'}; other rules unchanged: ${untouchedSame}`);
  if (!isEmpty(again) || !untouchedSame) process.exitCode = 1;
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## SmartThings holiday rules\n\n${log.map((l) => `- ${l.trim()}`).join('\n')}\n`);
