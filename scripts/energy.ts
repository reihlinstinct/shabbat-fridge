/**
 * Print energy per interval and per day from decrypted snapshots. Run where the decrypted files live (never in CI).
 *   SNAP_DIR (as for analyze.ts), TZID (default: the place in the newest snapshot)
 * Output is for the owner only: it contains consumption data.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { intervalsOf, perDay, type EnergySnapshot } from '../src/energyseries.js';

const dir = join(process.env.SNAP_DIR ?? '', 'snapshots');
const snaps: Array<EnergySnapshot & { place?: { tzid?: string } }> = [];
for (const m of readdirSync(dir)) for (const f of readdirSync(join(dir, m))) snaps.push(JSON.parse(readFileSync(join(dir, m, f), 'utf8')));
if (snaps.length === 0) throw new Error('no snapshots found');
snaps.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
const tzid = process.env.TZID || snaps[snaps.length - 1]!.place?.tzid || 'UTC';
const { intervals, skipped } = intervalsOf(snaps);
console.log(`Snapshots: ${snaps.length}, intervals: ${intervals.length}, skipped: ${skipped}, time zone: ${tzid}`);
for (const d of perDay(intervals, tzid)) console.log(`${d.day}  ${(d.wh / 1000).toFixed(3)} kWh over ${d.hours.toFixed(1)} h (${((d.wh / d.hours) | 0)} W mean)${d.hasGap ? '  includes a gap' : ''}`);
