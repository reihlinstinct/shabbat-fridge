import { HebrewCalendar, Location, Zmanim, flags } from '@hebcal/core';

export interface Place {
  latitude: number;
  longitude: number;
  /** IANA time zone, e.g. "Asia/Jerusalem". */
  tzid: string;
  /** true: Israel calendar (one day of Yom Tov). false: Diaspora (two days). */
  israel: boolean;
}

export interface Options {
  /** Minutes before sunset that the mode must be ON (default 10, like the Samsung fridge). */
  entryMinutesBeforeSunset?: number;
  /** Minutes after sunset that the mode turns OFF (default 40, like the Samsung fridge). */
  exitMinutesAfterSunset?: number;
  /** Treat Yom Kippur as a block day (default true). */
  includeYomKippur?: boolean;
}

export interface Block {
  /** Instant to turn the mode ON. */
  start: Date;
  /** Instant to turn the mode OFF. */
  end: Date;
  /** Local calendar days (YYYY-MM-DD) covered, first to last. */
  days: string[];
  /** Why each day is in the block (Shabbat or the Hebcal holiday name). */
  reasons: string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Days that are Yom Tov (Chag) in the chosen calendar, keyed by local YYYY-MM-DD. */
function yomTovDays(place: Place, start: Date, end: Date, includeYomKippur: boolean): Map<string, string> {
  const events = HebrewCalendar.calendar({ start, end, il: place.israel, noHolidays: false, mask: flags.CHAG });
  const out = new Map<string, string>();
  for (const ev of events) {
    const name = ev.getDesc();
    if (!includeYomKippur && name === 'Yom Kippur') continue;
    out.set(ymd(ev.getDate().greg()), name);
  }
  return out;
}

export function sunset(place: Place, day: Date): Date {
  const loc = new Location(place.latitude, place.longitude, place.israel, place.tzid);
  return new Zmanim(loc, day, false).sunset();
}

/**
 * Contiguous "no-touch" blocks between start and end (local dates, inclusive).
 * Adjacent days (Yom Tov next to Shabbat, or Yom Tov days in a row) merge into one block,
 * so the mode never drops in the middle of a holiday.
 * A block is returned if any part of it, from its ON time on the eve to its OFF time, falls on a day in the range.
 */
export function computeBlocks(place: Place, start: Date, end: Date, opts: Options = {}): Block[] {
  const entry = opts.entryMinutesBeforeSunset ?? 10;
  const exit = opts.exitMinutesAfterSunset ?? 40;
  // Pad the range so a block that straddles the edges is seen whole.
  const from = addDays(start, -3);
  const to = addDays(end, 3);
  const yt = yomTovDays(place, from, to, opts.includeYomKippur ?? true);

  const blocks: Block[] = [];
  let cur: { first: Date; last: Date; days: string[]; reasons: string[] } | undefined;
  const flush = (): void => {
    if (!cur) return;
    blocks.push({
      start: new Date(sunset(place, addDays(cur.first, -1)).getTime() - entry * 60000),
      end: new Date(sunset(place, cur.last).getTime() + exit * 60000),
      days: cur.days,
      reasons: cur.reasons,
    });
    cur = undefined;
  };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const key = ymd(d);
    const reason = yt.get(key) ?? (d.getDay() === 6 ? 'Shabbat' : undefined);
    if (reason) {
      if (cur) {
        cur.last = d;
        cur.days.push(key);
        cur.reasons.push(reason);
      } else {
        cur = { first: d, last: d, days: [key], reasons: [reason] };
      }
    } else {
      flush();
    }
  }
  flush();
  const s = ymd(start);
  const e = ymd(end);
  // Keep blocks whose ON time (the eve of the first day) up to OFF time touches [start, end].
  return blocks.filter((b) => b.days[b.days.length - 1]! >= s && ymd(addDays(new Date(b.days[0]! + 'T00:00:00'), -1)) <= e);
}
