/**
 * Generate SmartThings Rules JSON. Reads settings from the environment so no private data lives in the repo.
 *   LAT, LON, TZ, ISRAEL=true|false, DEVICE_ID, START=YYYY-MM-DD, YEARS=10,
 *   MODE=holiday|merged, ENTRY=60, EXIT=90, REENTER=100, YOM_KIPPUR=true|false, OUT=/path/out.json
 * Output is a JSON array of rules (one per year), ready for `smartthings rules:create -i` one rule at a time
 * or for the Rules API. Nothing here talks to SmartThings.
 */
import { writeFileSync } from 'node:fs';
import { computeBlocks } from '../src/blocks.js';
import { blocksToActions, holidayOnlyActions, rulesByYear } from '../src/rules.js';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
};
const [y, m, d] = env('START').split('-').map(Number) as [number, number, number];
const start = new Date(y, m - 1, d);
const end = new Date(y + Number(env('YEARS', '10')), m - 1, d);
const entry = Number(env('ENTRY', '60'));
const exit = Number(env('EXIT', '90'));
const place = {
  latitude: Number(env('LAT')),
  longitude: Number(env('LON')),
  tzid: env('TZ'),
  israel: env('ISRAEL', 'true') === 'true',
};
const blocks = computeBlocks(place, start, end, { entryMinutesBeforeSunset: entry, exitMinutesAfterSunset: exit, includeYomKippur: env('YOM_KIPPUR', 'true') === 'true' });
const opts = { deviceId: env('DEVICE_ID'), entryMinutesBeforeSunset: entry, exitMinutesAfterSunset: exit, reenterMinutesAfterSunset: Number(env('REENTER', '100')) };
const mode = env('MODE', 'holiday');
const actions = mode === 'merged' ? blocksToActions(blocks, opts) : holidayOnlyActions(blocks, opts);
const rules = rulesByYear(mode === 'merged' ? 'shabbat-fridge full' : 'shabbat-fridge holidays', actions);
writeFileSync(env('OUT'), JSON.stringify(rules, null, 2));
console.log(`${mode}: ${blocks.length} blocks, ${actions.length} actions, ${rules.length} rules (${rules.map((r) => r.actions.length).join(',')})`);
