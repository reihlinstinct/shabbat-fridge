/**
 * Read-only snapshot of the fridge for later incident analysis. Writes files only under OUT_DIR, which must be
 * a PRIVATE location (the files hold device and location ids, coordinates and door timing).
 *   ST_TOKEN, OUT_DIR, RETAIN_DAYS=365, LOCATION_ID/DEVICE_ID (optional, auto-detected when exactly one)
 * Writes: snapshots/YYYY-MM/<time>.json (status, rules summary, place) and events/YYYY-MM.ndjson (deduplicated history).
 * Only GET requests are made. The token is never printed or written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SmartThings, sabbathDevices } from '../src/smartthings.js';
import { isExpired, isMonthExpired, newEventLines, parseRetainDays } from '../src/collect.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const token = env('ST_TOKEN');
if (!token) throw new Error('missing ST_TOKEN');
const out = env('OUT_DIR');
if (!out) throw new Error('missing OUT_DIR (a private directory)');
const retainDays = parseRetainDays(env('RETAIN_DAYS', '365'));

const st = new SmartThings(token);
const locs = await st.locations();
const locationId = env('LOCATION_ID') || (locs.length === 1 ? locs[0]!.locationId : '');
if (!locationId) throw new Error(`Found ${locs.length} locations; set LOCATION_ID`);
const loc = await st.location(locationId);
const fridges = sabbathDevices(await st.devices(), locationId);
const deviceId = env('DEVICE_ID') || (fridges.length === 1 ? fridges[0]!.deviceId : '');
if (!deviceId) throw new Error(`Found ${fridges.length} devices with samsungce.sabbathMode; set DEVICE_ID`);

const takenAt = new Date().toISOString();
const status = (await st.deviceStatus(deviceId)) as { components?: { main?: Record<string, { status?: { value?: string; timestamp?: string } }> } };
const sab = status.components?.main?.['samsungce.sabbathMode']?.status;
const rules = [];
for (const s of await st.rules(locationId)) {
  const r = (await st.rule(locationId, s.id)) as unknown as Record<string, unknown>;
  rules.push({ id: r.id, name: r.name, status: r.status, dateExecuted: r.dateExecuted, dateUpdated: r.dateUpdated });
}
const snapshot = {
  takenAt,
  place: { latitude: loc.latitude, longitude: loc.longitude, tzid: loc.timeZoneId, countryCode: loc.countryCode },
  sabbath: sab?.value && sab.timestamp ? { value: sab.value, timestamp: sab.timestamp } : null,
  status,
  rules,
};
const month = takenAt.slice(0, 7);
mkdirSync(join(out, 'snapshots', month), { recursive: true });
writeFileSync(join(out, 'snapshots', month, `${takenAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(snapshot, null, 1));

// History beyond SmartThings' ~7 days: append events not seen before.
mkdirSync(join(out, 'events'), { recursive: true });
const seenByMonth = new Map<string, Set<string>>();
const seenIn = (month: string): Set<string> => {
  let set = seenByMonth.get(month);
  if (!set) {
    set = new Set<string>();
    const file = join(out, 'events', `${month}.ndjson`);
    if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) if (l) set.add((JSON.parse(l) as { k: string }).k);
    seenByMonth.set(month, set);
  }
  return set;
};
let added = 0;
const events = await st.deviceHistory(locationId, deviceId);
const months = new Set(events.map((e) => String(e.time).slice(0, 7)));
const all = new Set<string>();
for (const m of months) for (const k of seenIn(m)) all.add(k);
for (const { month, line } of newEventLines(all, events)) {
  appendFileSync(join(out, 'events', `${month}.ndjson`), line + '\n');
  added++;
}

// Retention (working tree only; Git history keeps deleted files, see docs/FORENSICS.md).
const now = Date.now();
let removed = 0;
const dir = join(out, 'snapshots');
for (const m of existsSync(dir) ? readdirSync(dir) : []) {
  for (const f of readdirSync(join(dir, m))) {
    const p = join(dir, m, f);
    const takenAt = (JSON.parse(readFileSync(p, 'utf8')) as { takenAt?: string }).takenAt ?? '';
    if (isExpired(takenAt, now, retainDays)) { rmSync(p); removed++; }
  }
}
for (const f of readdirSync(join(out, 'events'))) {
  if (/^\d{4}-\d{2}\.ndjson$/.test(f) && isMonthExpired(f.slice(0, 7), now, retainDays)) { rmSync(join(out, 'events', f)); removed++; }
}
console.log(`Snapshot saved. Sabbath mode: ${snapshot.sabbath ? snapshot.sabbath.value : 'unknown'}. New history events: ${added}. Old files removed: ${removed}.`);
