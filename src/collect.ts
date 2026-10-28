import type { HistoryEvent } from './smartthings.js';

/** Identity of one history event. Includes capability, attribute and value so distinct events never collide. */
export function eventKey(e: HistoryEvent): string {
  return [e.epoch ?? e.time, e.hash ?? '', e.capability ?? '', e.attribute ?? '', JSON.stringify(e.value ?? null)].join('|');
}

/** Lines to append for events not seen before (also dedupes inside the batch). `seen` is updated. */
export function newEventLines(seen: Set<string>, events: HistoryEvent[]): Array<{ month: string; line: string }> {
  const out: Array<{ month: string; line: string }> = [];
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ month: String(e.time).slice(0, 7), line: JSON.stringify({ k, time: e.time, capability: e.capability, attribute: e.attribute, value: e.value }) });
  }
  return out;
}

/** RETAIN_DAYS must be a finite positive number; anything else fails instead of deleting everything. */
export function parseRetainDays(raw: string): number {
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || n <= 0) throw new Error(`RETAIN_DAYS must be a positive number (got "${raw}")`);
  return n;
}

/** A snapshot is expired by its own takenAt, not by file time (a git checkout resets file times). */
export const isExpired = (takenAt: string, now: number, retainDays: number): boolean => {
  const t = Date.parse(takenAt);
  return Number.isFinite(t) && t < now - retainDays * 86400000;
};

/** An events file YYYY-MM is expired when its whole month ended before the cutoff. */
export const isMonthExpired = (month: string, now: number, retainDays: number): boolean => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Date.UTC(y, m, 1) < now - retainDays * 86400000;
};
