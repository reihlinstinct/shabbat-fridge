import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RECORD_CONTEXT, collectOnce, type Client } from '../src/collectrun.js';
import { applyCursor, readCursor } from '../src/cursorfile.js';
import { assemble, chunkSize, decryptChunk, generateKeyPair } from '../src/logcrypt.js';
import { HOUR_MS, CodedError, eventsSince, fitEvents, nextCursor, type LogRecord, type RecordEvent } from '../src/record.js';
import type { OAuthState } from '../src/oauth.js';
import type { HistoryEvent } from '../src/smartthings.js';
import { isState, newKey, open, seal } from '../src/statecrypt.js';

const kp = generateKeyPair();
const NOW = Date.parse('2026-10-28T12:30:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (time: string, value: unknown = 'closed', n = 0): HistoryEvent => ({ time, epoch: Date.parse(time), hash: n, componentId: 'main', capability: 'contactSensor', attribute: 'contact', value });
const base = { v: 1 as const, takenAt: iso(NOW), place: { latitude: 1, longitude: 2, tzid: 'Asia/Jerusalem', countryCode: 'ISR' }, sabbath: null, rules: [] };

describe('cursor', () => {
  const e = (t: string): RecordEvent => ({ k: t, time: t });
  it('floors to the hour and subtracts the 1 hour overlap', () => {
    expect(nextCursor(undefined, [e('2026-10-28T10:47:12.000Z')], 0, false, NOW)).toBe('2026-10-28T09:00:00.000Z');
  });
  it('never moves back and keeps the old value with no events', () => {
    expect(nextCursor('2026-10-28T11:00:00.000Z', [e('2026-10-28T10:47:12.000Z')], 0, false, NOW)).toBe('2026-10-28T11:00:00.000Z');
    expect(nextCursor('2026-10-28T11:00:00.000Z', [], 0, false, NOW)).toBe('2026-10-28T11:00:00.000Z');
    expect(nextCursor(undefined, [], 0, false, NOW)).toBeUndefined();
  });
  it('ignores future event times', () => {
    expect(nextCursor(undefined, [e('2026-10-28T10:10:00.000Z'), e('2027-01-01T00:00:00.000Z')], 0, false, NOW)).toBe('2026-10-28T09:00:00.000Z');
    expect(nextCursor('2026-10-28T08:00:00.000Z', [e('2027-01-01T00:00:00.000Z')], 0, false, NOW)).toBe('2026-10-28T08:00:00.000Z');
  });
  it('does not advance when the history was truncated', () => {
    expect(nextCursor('2026-10-28T08:00:00.000Z', [e('2026-10-28T12:00:00.000Z')], 0, true, NOW)).toBe('2026-10-28T08:00:00.000Z');
  });
  it('throws fit-stall when events were left out and the cursor cannot advance', () => {
    expect(() => nextCursor('2026-10-28T11:00:00.000Z', [e('2026-10-28T11:20:00.000Z')], 5, false, NOW)).toThrow(CodedError);
    expect(() => nextCursor('2026-10-28T11:00:00.000Z', [], 5, false, NOW)).toThrow(/fit-stall/);
    expect(nextCursor('2026-10-28T06:00:00.000Z', [e('2026-10-28T11:20:00.000Z')], 5, false, NOW)).toBe('2026-10-28T10:00:00.000Z');
  });
  it('rejects a bad event time (fail closed)', () => {
    expect(() => nextCursor(undefined, [e('garbage')], 0, false, NOW)).toThrow(/bad-event-time/);
    expect(() => eventsSince([ev('garbage')], undefined)).toThrow(/bad-event-time/);
  });
});

describe('eventsSince and fit', () => {
  it('keeps events strictly newer than the cursor, oldest first, each with its dedupe key', () => {
    const out = eventsSince([ev('2026-10-28T10:00:00.000Z', 'open', 2), ev('2026-10-28T08:00:00.000Z', 'open', 1), ev('2026-10-28T09:00:00.000Z', 'closed', 3)], '2026-10-28T08:30:00.000Z');
    expect(out.map((o) => o.time)).toEqual(['2026-10-28T09:00:00.000Z', '2026-10-28T10:00:00.000Z']);
    expect(out[0]!.k).toContain('contactSensor');
    expect(eventsSince([ev('2026-10-28T08:00:00.000Z')], undefined)).toHaveLength(1);
  });
  it('sends the oldest events that fit and leaves the rest', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ev(iso(NOW - (3000 - i) * 60000), Math.random().toString(36), i));
    const wanted = eventsSince(many, undefined);
    const fit = fitEvents(base, wanted);
    expect(fit.length).toBeGreaterThan(10);
    expect(fit.length).toBeLessThan(wanted.length);
    expect(fit[0]).toEqual(wanted[0]);
    expect(fitEvents(base, wanted.slice(0, 3))).toHaveLength(3);
  });
  it('throws record-too-big when even an empty record does not fit', () => {
    const big = { ...base, rules: Array.from({ length: 5000 }, (_, i) => ({ id: Math.random().toString(36) + i, name: Math.random().toString(36), status: 'x', dateExecuted: 1, dateUpdated: 2 })) };
    expect(() => fitEvents(big, [])).toThrow(/record-too-big/);
  });
});

const client = (events: HistoryEvent[], truncated = false): Client => ({
  locations: async () => [{ locationId: 'L1' }],
  location: async () => ({ locationId: 'L1', latitude: 32.1, longitude: 34.8, timeZoneId: 'Asia/Jerusalem', countryCode: 'ISR' }),
  devices: async () => [{ deviceId: 'D1', locationId: 'L1', components: [{ id: 'main', capabilities: [{ id: 'samsungce.sabbathMode' }] }] }] as never,
  deviceStatus: async () => ({ components: { main: { 'samsungce.sabbathMode': { status: { value: 'off', timestamp: '2026-10-24T16:27:01Z' } } } } }),
  rules: async () => [{ id: 'R1' }],
  rule: async () => ({ id: 'R1', name: 'rule', status: 'Active', dateExecuted: 5, dateUpdated: 6, actions: ['SECRET-ACTIONS'] }),
  deviceHistoryResult: async () => ({ events, truncated }),
});
const read = (chunk: Buffer): LogRecord => JSON.parse(gunzipSync(assemble([decryptChunk(chunk, kp.privateKey, RECORD_CONTEXT)])).toString('utf8')) as LogRecord;

describe('collectOnce', () => {
  const now = new Date(NOW);
  it('returns exactly one fixed-size chunk with the slim record', async () => {
    const r = await collectOnce({ client: client([ev('2026-10-28T10:47:12.000Z')]), publicKey: kp.publicKey, cursor: undefined, now });
    expect(r.chunk.length).toBe(chunkSize());
    const rec = read(r.chunk);
    expect(rec.v).toBe(1);
    expect(rec.sabbath).toEqual({ value: 'off', timestamp: '2026-10-24T16:27:01Z' });
    expect(rec.rules).toEqual([{ id: 'R1', name: 'rule', status: 'Active', dateExecuted: 5, dateUpdated: 6 }]);
    expect(rec.events).toHaveLength(1);
    expect(JSON.stringify(rec)).not.toContain('SECRET-ACTIONS');
    expect(JSON.stringify(rec)).not.toContain('"status":{"components"');
    expect(r.cursor).toBe('2026-10-28T09:00:00.000Z');
  });
  it('an empty run still returns a chunk of the same size, and keeps the cursor', async () => {
    const r = await collectOnce({ client: client([]), publicKey: kp.publicKey, cursor: '2026-10-28T09:00:00.000Z', now });
    expect(r.chunk.length).toBe(chunkSize());
    expect(r.cursor).toBe('2026-10-28T09:00:00.000Z');
  });
  it('only sends events after the cursor', async () => {
    const r = await collectOnce({ client: client([ev('2026-10-28T08:00:00.000Z', 'a', 1), ev('2026-10-28T11:00:00.000Z', 'b', 2)]), publicKey: kp.publicKey, cursor: '2026-10-28T09:00:00.000Z', now });
    expect(read(r.chunk).events.map((e) => e.time)).toEqual(['2026-10-28T11:00:00.000Z']);
  });
  it('writes its chunk but does not advance the cursor when history is truncated', async () => {
    const r = await collectOnce({ client: client([ev('2026-10-28T11:30:00.000Z')], true), publicKey: kp.publicKey, cursor: '2026-10-28T06:00:00.000Z', now });
    expect(r.chunk.length).toBe(chunkSize());
    expect(r.cursor).toBe('2026-10-28T06:00:00.000Z');
  });
  it('is read-only: only the client reads are called', async () => {
    const c = client([]);
    const called: string[] = [];
    const spy = Object.fromEntries(Object.entries(c).map(([k, f]) => [k, (...a: unknown[]) => { called.push(k); return (f as (...x: unknown[]) => unknown)(...a); }])) as unknown as Client;
    await collectOnce({ client: spy, publicKey: kp.publicKey, cursor: undefined, now });
    expect(new Set(called)).toEqual(new Set(['locations', 'location', 'devices', 'deviceStatus', 'rules', 'rule', 'deviceHistoryResult']));
  });
  it('fails with a coded error for an ambiguous location or device', async () => {
    const c = client([]);
    await expect(collectOnce({ client: { ...c, locations: async () => [{ locationId: 'A' }, { locationId: 'B' }] }, publicKey: kp.publicKey, cursor: undefined, now })).rejects.toThrow(/location-ambiguous/);
    await expect(collectOnce({ client: { ...c, devices: async () => [] }, publicKey: kp.publicKey, cursor: undefined, now })).rejects.toThrow(/device-ambiguous/);
  });
});

describe('state cursor', () => {
  const STATE: OAuthState = { clientId: 'CID', clientSecret: 'CSECRET', refreshToken: 'RT-1', obtainedAt: '2026-10-28T00:00:00.000Z' };
  const make = (st: OAuthState) => {
    const key = newKey();
    const file = join(mkdtempSync(join(tmpdir(), 'cur-')), 's.json');
    writeFileSync(file, JSON.stringify(seal(st, key)));
    return { key, file };
  };
  it('an old-format state without eventCursor still opens', () => {
    const { key, file } = make(STATE);
    expect(readCursor(file, key)).toBeUndefined();
  });
  it('validates the cursor format on open', () => {
    expect(isState({ ...STATE, eventCursor: '2026-10-28T09:00:00.000Z' })).toBe(true);
    for (const bad of ['yesterday', '2026-10-28', 42, '2026-13-45T00:00:00Z', '2026-10-28T09:00:00+02:00']) expect(isState({ ...STATE, eventCursor: bad })).toBe(false);
  });
  it('seal uses a fresh random nonce: sealing the same state twice gives different bytes', () => {
    const key = newKey();
    const a = JSON.stringify(seal(STATE, key));
    const b = JSON.stringify(seal(STATE, key));
    expect(a).not.toBe(b);
  });
  it('applyCursor writes new ciphertext even when the cursor is unchanged, and keeps every other field', () => {
    const { key, file } = make({ ...STATE, eventCursor: '2026-10-28T09:00:00.000Z' });
    const before = readFileSync(file, 'utf8');
    applyCursor(file, key, '2026-10-28T09:00:00.000Z');
    const after = readFileSync(file, 'utf8');
    expect(after).not.toBe(before);
    expect(open(JSON.parse(after), key)).toEqual({ ...STATE, eventCursor: '2026-10-28T09:00:00.000Z' });
  });
  it('applyCursor sets and keeps the cursor, and fails closed on a bad write', () => {
    const { key, file } = make(STATE);
    applyCursor(file, key, '2026-10-28T10:00:00.000Z');
    expect(readCursor(file, key)).toBe('2026-10-28T10:00:00.000Z');
    applyCursor(file, key, undefined);
    expect(readCursor(file, key)).toBe('2026-10-28T10:00:00.000Z');
    const keep = readFileSync(file, 'utf8');
    expect(() => applyCursor(file, key, '2026-10-28T11:00:00.000Z', (p) => writeFileSync(p, 'not json'))).toThrow(/read back/);
    expect(readFileSync(file, 'utf8')).toBe(keep);
  });
  it('hour constant is one hour', () => expect(HOUR_MS).toBe(3600000));
});

import { spawnSync } from 'node:child_process';
describe('collector scripts print fixed text only', () => {
  const run = (script: string, env: Record<string, string>) => spawnSync('npx', ['--no-install', 'tsx', script], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8' });
  it('collect-encrypted names a missing variable by code only', () => {
    const r = run('scripts/collect-encrypted.ts', {});
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('collector failed: missing-st-token');
  });
  it('an internal error prints the fixed code and never the secret-looking inputs', () => {
    const r = run('scripts/collect-encrypted.ts', { ST_TOKEN: 'CANARY-TOKEN', STATE_FILE: '/nonexistent/CANARY-PATH', STATE_KEY: 'CANARY-KEY', CHUNK_DIR: '/tmp', CURSOR_OUT: '/tmp/x' });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('collector failed: internal');
    expect(r.stdout + r.stderr).not.toContain('CANARY');
  });
  it('apply-cursor prints fixed text on failure', () => {
    const r = run('scripts/apply-cursor.ts', { STATE_FILE: '/nonexistent/CANARY', STATE_KEY: 'CANARY', CURSOR_OUT: '/nonexistent/CANARY' });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apply-cursor failed');
    expect(r.stdout + r.stderr).not.toContain('CANARY');
  });
});

import { existsSync, readdirSync } from 'node:fs';
import { fakeSt } from './fixtures/fake-st.js';
import { SmartThings } from '../src/smartthings.js';
import { errorCode } from '../src/record.js';
import { resolve } from 'node:path';

describe('review follow-ups', () => {
  const now = new Date(NOW);
  it('overflow: ~3000 events give one chunk, the cursor follows the last included event, and the next run continues', async () => {
    const all = Array.from({ length: 3000 }, (_, i) => ev(iso(NOW - 40 * 3600e3 + i * 40000), Math.random().toString(36), i));
    const r1 = await collectOnce({ client: client(all), publicKey: kp.publicKey, cursor: undefined, now });
    expect(r1.chunk.length).toBe(chunkSize());
    const rec1 = read(r1.chunk);
    expect(rec1.events.length).toBeGreaterThan(10);
    expect(rec1.events.length).toBeLessThan(3000);
    const newest = Math.max(...rec1.events.map((e) => Date.parse(e.time)));
    expect(r1.cursor).toBe(iso(Math.floor(newest / HOUR_MS) * HOUR_MS - HOUR_MS));
    const r2 = await collectOnce({ client: client(all), publicKey: kp.publicKey, cursor: r1.cursor, now });
    const rec2 = read(r2.chunk);
    expect(Date.parse(rec2.events[0]!.time)).toBeGreaterThan(Date.parse(r1.cursor!));
    expect(Date.parse(r2.cursor!)).toBeGreaterThan(Date.parse(r1.cursor!));
  });
  it('fit-stall: a dense hour that cannot advance the cursor fails with a coded error', async () => {
    const dense = Array.from({ length: 4000 }, (_, i) => ev(iso(Date.parse('2026-10-28T11:00:01Z') + i * 400), Math.random().toString(36), i));
    await expect(collectOnce({ client: client(dense), publicKey: kp.publicKey, cursor: '2026-10-28T11:00:00.000Z', now })).rejects.toThrow(/fit-stall/);
  });
  it('a future-dated event is sent but does not move the cursor', async () => {
    const r = await collectOnce({ client: client([ev('2027-03-01T00:00:00.000Z')]), publicKey: kp.publicKey, cursor: '2026-10-28T08:00:00.000Z', now });
    expect(read(r.chunk).events).toHaveLength(1);
    expect(r.cursor).toBe('2026-10-28T08:00:00.000Z');
  });
  it('a real SmartThings client run makes only GET requests', async () => {
    const log: Array<{ method: string; path: string }> = [];
    const st = new SmartThings('T', fakeSt([ev('2026-10-28T10:00:00.000Z')], log));
    const r = await collectOnce({ client: st, publicKey: kp.publicKey, cursor: undefined, now });
    expect(r.chunk.length).toBe(chunkSize());
    expect(log.length).toBeGreaterThan(5);
    expect(log.every((l) => l.method === 'GET')).toBe(true);
    expect(new Set(log.map((l) => l.path))).toEqual(new Set(['/locations', '/locations/L1', '/devices', '/devices/D1/status', '/rules', '/rules/R1', '/history/devices']));
  });
  it('error codes: status class, bad response, coded, internal', () => {
    expect(errorCode(new Error('SmartThings GET /devices failed with HTTP 503'))).toBe('smartthings-http-5xx');
    expect(errorCode(new Error('SmartThings GET /devices failed with HTTP 401'))).toBe('smartthings-http-4xx');
    expect(errorCode(new Error('SmartThings GET /x returned a non-JSON response (HTTP 200)'))).toBe('smartthings-bad-response');
    expect(errorCode(new CodedError('fit-stall'))).toBe('fit-stall');
    expect(errorCode(new Error('CANARY'))).toBe('internal');
    expect(errorCode('CANARY')).toBe('internal');
  });
  it('applyCursor ignores an older cursor and leaves no .tmp file behind', () => {
    const key = newKey();
    const dir = mkdtempSync(join(tmpdir(), 'cur2-'));
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify(seal({ clientId: 'C', clientSecret: 'S', refreshToken: 'R', obtainedAt: '2026-10-28T00:00:00.000Z', eventCursor: '2026-10-28T10:00:00.000Z' }, key)));
    applyCursor(file, key, '2026-10-28T08:00:00.000Z');
    expect(readCursor(file, key)).toBe('2026-10-28T10:00:00.000Z');
    applyCursor(file, key, '2026-10-28T11:00:00.000Z');
    expect(readCursor(file, key)).toBe('2026-10-28T11:00:00.000Z');
    expect(() => applyCursor(file, key, '2026-10-28T12:00:00.000Z', (p) => writeFileSync(p, 'junk'))).toThrow();
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readdirSync(dir)).toEqual(['s.json']);
  });
  const stub = resolve('test/fixtures/fetch-stub.mjs');
  const run = (script: string, env: Record<string, string>) => spawnSync('npx', ['--no-install', 'tsx', script], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_OPTIONS: `--import ${stub}`, ...env }, encoding: 'utf8' });
  it('script success path: collect-encrypted writes one chunk and the hand-off, apply-cursor seals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-'));
    const key = newKey();
    const stateFile = join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify(seal({ clientId: 'C', clientSecret: 'S', refreshToken: 'R', obtainedAt: '2026-10-28T00:00:00.000Z' }, key)));
    const pub = join(dir, 'logs.pub');
    writeFileSync(pub, kp.publicKey + '\n');
    const out = join(dir, 'out');
    const handoff = join(dir, 'cursor.json');
    const t = new Date().toISOString();
    const env = { ST_TOKEN: 'T', STATE_FILE: stateFile, STATE_KEY: key, LOGS_PUBLIC_KEY_FILE: pub, CHUNK_DIR: out, CURSOR_OUT: handoff, STUB_EVENTS: JSON.stringify([ev(t)]) };
    const r = run('scripts/collect-encrypted.ts', env);
    expect(r.stdout).toBe('chunk written\n');
    expect(r.status).toBe(0);
    const files = readdirSync(join(out, 'chunks'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.bin$/);
    expect(readFileSync(join(out, 'chunks', files[0]!)).length).toBe(chunkSize());
    const cur = (JSON.parse(readFileSync(handoff, 'utf8')) as { cursor: string | null }).cursor;
    expect(cur).toBe(iso(Math.floor(Date.parse(t) / HOUR_MS) * HOUR_MS - HOUR_MS));
    const a = run('scripts/apply-cursor.ts', env);
    expect(a.stdout).toBe('state sealed\n');
    expect(a.status).toBe(0);
    expect(readCursor(stateFile, key)).toBe(cur);
    expect(existsSync(`${stateFile}.tmp`)).toBe(false);
  });
});

describe('energy counters', () => {
  const full = { components: { main: {
    'samsungce.sabbathMode': { status: { value: 'off', timestamp: '2026-10-24T16:27:01Z' } },
    powerConsumptionReport: { powerConsumption: { value: { energy: 821934, deltaEnergy: 1, power: 1, powerEnergy: 0.4, start: '2026-10-28T13:30:18Z', end: '2026-10-28T13:43:42Z 2026-10-28T13:43:42Z', CANARY: 'x' } } },
    'samsungce.energyManagement': { thisMonthEnergyConsumption: { value: 41979 }, lastMonthEnergyConsumption: { value: null } },
  } } };
  const runWith = async (status: unknown) => {
    const c = { ...client([]), deviceStatus: async () => status } as Client;
    const r = await collectOnce({ client: c, publicKey: kp.publicKey, cursor: undefined, now: new Date('2026-10-28T14:00:00Z') });
    return read(r.chunk);
  };
  it('records finite numbers and parseable times from the two capabilities, and nothing else', async () => {
    const rec = await runWith(full);
    expect(rec.energy).toEqual({ totalWh: 821934, deltaWh: 1, powerW: 1, windowStart: '2026-10-28T13:30:18Z', windowEnd: '2026-10-28T13:43:42Z', monthWh: 41979 });
  });
  it('drops non-numbers and bad times, and omits the field when the device reports nothing', async () => {
    const bad = { components: { main: { powerConsumptionReport: { powerConsumption: { value: { energy: 'CANARY', power: NaN, start: 'CANARY' } } }, 'samsungce.energyManagement': { thisMonthEnergyConsumption: { value: '5' } } } } };
    expect((await runWith(bad)).energy).toBeUndefined();
    expect((await runWith({ components: { main: {} } })).energy).toBeUndefined();
  });
});
