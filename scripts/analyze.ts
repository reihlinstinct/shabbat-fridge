/**
 * Compare collected snapshots with the scheduled Sabbath blocks. Run it where the snapshots live (private).
 *   SNAP_DIR, ENTRY=60, EXIT=90, YOM_KIPPUR=true, ISRAEL=true|false (default: from the snapshot country), TOL=15
 * Prints a findings table (calendar dates and minutes only) and a sanitized one-line summary for public use.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBlocks } from '../src/blocks.js';
import { analyze, maxGapMinutes, summarize, type Snapshot } from '../src/forensics.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const dir = join(env('SNAP_DIR'), 'snapshots');
const snaps: Array<Snapshot & { place: { latitude: number; longitude: number; tzid: string; countryCode?: string } }> = [];
for (const m of readdirSync(dir)) for (const f of readdirSync(join(dir, m))) snaps.push(JSON.parse(readFileSync(join(dir, m, f), 'utf8')));
if (snaps.length === 0) throw new Error('no snapshots found');
snaps.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
const p = snaps[snaps.length - 1]!.place;
const israel = env('ISRAEL') ? env('ISRAEL') === 'true' : p.countryCode === 'ISR' || p.countryCode === 'IL';
const start = new Date(new Date(snaps[0]!.takenAt).getTime() - 3 * 86400000);
const end = new Date(new Date(snaps[snaps.length - 1]!.takenAt).getTime() + 3 * 86400000);
const blocks = computeBlocks({ latitude: p.latitude, longitude: p.longitude, tzid: p.tzid, israel }, start, end, {
  entryMinutesBeforeSunset: Number(env('ENTRY', '60')),
  exitMinutesAfterSunset: Number(env('EXIT', '90')),
  includeYomKippur: env('YOM_KIPPUR', 'true') === 'true',
});
const findings = analyze(snaps, blocks, Number(env('TOL', '15')));
console.log(`Snapshots: ${snaps.length}, largest gap between snapshots: ${maxGapMinutes(snaps)} min (changes overwritten inside a gap cannot be seen)`);
for (const f of findings) console.log(`${f.kind.padEnd(14)} ${f.block}${f.minutes !== undefined ? ` (${f.minutes > 0 ? '+' : ''}${f.minutes} min)` : ''}  ${f.detail}`);
console.log(`Summary: ${summarize(findings)}`);
