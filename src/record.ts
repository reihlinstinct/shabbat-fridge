/**
 * The record one collector run encrypts (see docs/ENCRYPTED-LOGS-COLLECTOR.md, c1).
 * Pure functions: no file, network or console access.
 */
import { gzipSync } from 'node:zlib';
import { eventKey } from './collect.js';
import { DEFAULT_BUCKET } from './logcrypt.js';
import type { HistoryEvent } from './smartthings.js';

export const HOUR_MS = 3600 * 1000;
/** Event times further than this in the future are ignored for the cursor. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Payload header inside a chunk (group, index, total, length) plus a margin for gzip jitter. */
const FIT_MARGIN = 24 + 64;

export interface RecordEvent {
  k: string;
  time: string;
  component?: string;
  capability?: string;
  attribute?: string;
  value?: unknown;
}

export interface LogRecord {
  v: 1;
  takenAt: string;
  place: { latitude: number; longitude: number; tzid: string; countryCode?: string };
  sabbath: { value: string; timestamp: string } | null;
  rules: Array<{ id: unknown; name: unknown; status: unknown; dateExecuted: unknown; dateUpdated: unknown }>;
  events: RecordEvent[];
}

/** A coded error: only the code is ever printed by the collector scripts. */
export class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CodedError';
  }
}

export const toRecordEvent = (e: HistoryEvent): RecordEvent => ({ k: eventKey(e), time: String(e.time), component: (e.componentId ?? e.component) as string | undefined, capability: e.capability, attribute: e.attribute, value: e.value });

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new CodedError('bad-event-time');
  return t;
};

/** Events newer than the cursor, oldest first. Without a cursor, all events. A bad event time throws (fail closed). */
export function eventsSince(events: HistoryEvent[], cursor: string | undefined): RecordEvent[] {
  const from = cursor === undefined ? -Infinity : ms(cursor);
  return events
    .map(toRecordEvent)
    .filter((e) => ms(e.time) > from)
    .sort((a, b) => ms(a.time) - ms(b.time));
}

export const gzSize = (r: LogRecord): number => gzipSync(Buffer.from(JSON.stringify(r), 'utf8')).length;

/** The largest prefix of the oldest-first events that keeps the gzipped record inside one bucket. Throws `record-too-big` if even zero events do not fit. */
export function fitEvents(base: Omit<LogRecord, 'events'>, events: RecordEvent[], bucket = DEFAULT_BUCKET): RecordEvent[] {
  const limit = bucket - FIT_MARGIN;
  const size = (n: number): number => gzSize({ ...base, events: events.slice(0, n) });
  if (size(0) > limit) throw new CodedError('record-too-big');
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return events.slice(0, lo);
}

export const floorHour = (t: number): number => Math.floor(t / HOUR_MS) * HOUR_MS;

/**
 * The cursor to store after a chunk was pushed.
 * - truncated history: never advance.
 * - candidate = floor to the hour of the newest included event time (future times ignored) minus a 1 hour overlap.
 * - never moves back (max with the old value); no included events keeps the old value.
 * - if events were left out and the cursor would not advance, throws `fit-stall` instead of stalling silently.
 */
export function nextCursor(old: string | undefined, included: RecordEvent[], leftOut: number, truncated: boolean, now: number): string | undefined {
  if (truncated) return old;
  const usable = included.map((e) => ms(e.time)).filter((t) => t <= now + FUTURE_SKEW_MS);
  if (usable.length === 0) {
    if (leftOut > 0) throw new CodedError('fit-stall');
    return old;
  }
  const candidate = floorHour(Math.max(...usable)) - HOUR_MS;
  const oldMs = old === undefined ? -Infinity : ms(old);
  const next = Math.max(oldMs, candidate);
  if (leftOut > 0 && next <= oldMs) throw new CodedError('fit-stall');
  return next === -Infinity ? undefined : new Date(next).toISOString();
}
