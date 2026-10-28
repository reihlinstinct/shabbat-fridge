/**
 * One encrypted collector run, as a pure function over a SmartThings-like client (c1 of docs/ENCRYPTED-LOGS-COLLECTOR.md).
 * It reads only. It returns exactly one fixed-size chunk and the cursor to store after that chunk is pushed.
 */
import { DEFAULT_BUCKET, encryptLog } from './logcrypt.js';
import { CodedError, eventsSince, fitEvents, nextCursor, type LogRecord } from './record.js';
import { gzipSync } from 'node:zlib';
import { sabbathDevices, type HistoryEvent, type StDevice, type StLocation } from './smartthings.js';

export const RECORD_CONTEXT = 'shabbat-fridge/logs/record/v1';

export interface Client {
  locations(): Promise<StLocation[]>;
  location(id: string): Promise<StLocation>;
  devices(): Promise<StDevice[]>;
  deviceStatus(id: string): Promise<Record<string, unknown>>;
  rules(locationId: string): Promise<Array<{ id: string }>>;
  rule(locationId: string, id: string): Promise<object>;
  deviceHistoryResult(locationId: string, deviceId: string): Promise<{ events: HistoryEvent[]; truncated: boolean }>;
}

export interface RunInput {
  client: Client;
  publicKey: string;
  cursor: string | undefined;
  now?: Date;
  bucket?: number;
  locationId?: string;
  deviceId?: string;
}

export async function collectOnce(inp: RunInput): Promise<{ chunk: Buffer; cursor: string | undefined }> {
  const now = inp.now ?? new Date();
  const bucket = inp.bucket ?? DEFAULT_BUCKET;
  const c = inp.client;
  const locs = await c.locations();
  const locationId = inp.locationId || (locs.length === 1 ? locs[0]!.locationId : '');
  if (!locationId) throw new CodedError('location-ambiguous');
  const loc = await c.location(locationId);
  const fridges = sabbathDevices(await c.devices(), locationId);
  const deviceId = inp.deviceId || (fridges.length === 1 ? fridges[0]!.deviceId : '');
  if (!deviceId) throw new CodedError('device-ambiguous');

  const status = (await c.deviceStatus(deviceId)) as { components?: { main?: Record<string, { status?: { value?: string; timestamp?: string } }> } };
  const sab = status.components?.main?.['samsungce.sabbathMode']?.status;
  const rules: LogRecord['rules'] = [];
  for (const s of await c.rules(locationId)) {
    const r = (await c.rule(locationId, s.id)) as Record<string, unknown>;
    rules.push({ id: r.id, name: r.name, status: r.status, dateExecuted: r.dateExecuted, dateUpdated: r.dateUpdated });
  }
  const base: Omit<LogRecord, 'events'> = {
    v: 1,
    takenAt: now.toISOString(),
    place: { latitude: Number(loc.latitude), longitude: Number(loc.longitude), tzid: String(loc.timeZoneId ?? ''), countryCode: loc.countryCode ?? undefined },
    sabbath: sab?.value && sab.timestamp ? { value: sab.value, timestamp: sab.timestamp } : null,
    rules,
  };
  const { events, truncated } = await c.deviceHistoryResult(locationId, deviceId);
  const wanted = eventsSince(events, inp.cursor);
  const included = fitEvents(base, wanted, bucket);
  const record: LogRecord = { ...base, events: included };
  const chunks = encryptLog(gzipSync(Buffer.from(JSON.stringify(record), 'utf8')), inp.publicKey, RECORD_CONTEXT, bucket);
  if (chunks.length !== 1) throw new CodedError('record-too-big');
  return { chunk: chunks[0]!, cursor: nextCursor(inp.cursor, included, wanted.length - included.length, truncated, now.getTime()) };
}
