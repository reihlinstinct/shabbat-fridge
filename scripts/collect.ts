/**
 * Read-only snapshot of the fridge for later incident analysis. Writes files only under OUT_DIR, which must be
 * a PRIVATE location (the files hold device and location ids, coordinates and door timing).
 *   ST_TOKEN, OUT_DIR, RETAIN_DAYS=365, LOCATION_ID/DEVICE_ID (optional, auto-detected when exactly one)
 * Writes: snapshots/YYYY-MM/<time>.json (status, rules summary, place) and events/YYYY-MM.ndjson (deduplicated history).
 * Only GET requests are made. The token is never printed or written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SmartThings, sabbathDevices } from '../src/smartthings.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const token = env('ST_TOKEN');
if (!token) throw new Error('missing ST_TOKEN');
const out = env('OUT_DIR');
if (!out) throw new Error('missing OUT_DIR (a private directory)');
const retainDays = Number(env('RETAIN_DAYS', '365'));

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
let added = 0;
for (const e of await st.deviceHistory(locationId, deviceId)) {
  const m = String(e.time).slice(0, 7);
  const file = join(out, 'events', `${m}.ndjson`);
  const key = `${e.epoch ?? e.time}:${e.hash ?? ''}`;
  const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (have.includes(`"k":"${key}"`)) continue;
  appendFileSync(file, JSON.stringify({ k: key, time: e.time, capability: e.capability, attribute: e.attribute, value: e.value }) + '\n');
  added++;
}

// Retention: delete snapshot files older than RETAIN_DAYS.
const cutoff = Date.now() - retainDays * 86400000;
let removed = 0;
const dir = join(out, 'snapshots');
for (const m of existsSync(dir) ? readdirSync(dir) : []) {
  for (const f of readdirSync(join(dir, m))) {
    const p = join(dir, m, f);
    if (statSync(p).mtimeMs < cutoff) { rmSync(p); removed++; }
  }
}
console.log(`Snapshot saved. Sabbath mode: ${snapshot.sabbath ? snapshot.sabbath.value : 'unknown'}. New history events: ${added}. Old snapshots removed: ${removed}.`);
