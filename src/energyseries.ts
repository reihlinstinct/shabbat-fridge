/**
 * Energy intervals from decrypted snapshots (pure, no file access). Used by scripts/energy.ts on the owner's side.
 * The counter is cumulative Wh. An interval is two consecutive snapshots that both carry `energy.totalWh`.
 */
export interface EnergySnapshot {
  takenAt: string;
  energy?: { totalWh?: number };
}

export interface Interval {
  from: string;
  to: string;
  hours: number;
  wh: number;
  /** Mean watts over the interval. */
  watts: number;
  /** True when the interval is longer than the gap limit: the collector missed runs, the mean hides detail. */
  gap: boolean;
}

export interface Series {
  intervals: Interval[];
  /** Snapshots without a usable counter, and pairs skipped for a time that does not move forward or a counter that went down. */
  skipped: number;
}

export const GAP_HOURS = 2.5;

export function intervalsOf(snaps: EnergySnapshot[], gapHours = GAP_HOURS): Series {
  const usable = snaps
    .filter((s) => typeof s.energy?.totalWh === 'number' && Number.isFinite(s.energy.totalWh) && Number.isFinite(Date.parse(s.takenAt)))
    .sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  let skipped = snaps.length - usable.length;
  const intervals: Interval[] = [];
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1]!;
    const b = usable[i]!;
    const hours = (Date.parse(b.takenAt) - Date.parse(a.takenAt)) / 3600000;
    const wh = b.energy!.totalWh! - a.energy!.totalWh!;
    if (hours <= 0 || wh < 0) {
      skipped++;
      continue;
    }
    intervals.push({ from: a.takenAt, to: b.takenAt, hours, wh, watts: wh / hours, gap: hours > gapHours });
  }
  return { intervals, skipped };
}

export interface DayTotal {
  day: string;
  wh: number;
  hours: number;
  hasGap: boolean;
}

/** Totals per local calendar day. An interval belongs to the day of its midpoint in the given time zone. */
export function perDay(intervals: Interval[], tzid: string): DayTotal[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, DayTotal>();
  for (const i of intervals) {
    const mid = new Date((Date.parse(i.from) + Date.parse(i.to)) / 2);
    const day = fmt.format(mid);
    const d = days.get(day) ?? { day, wh: 0, hours: 0, hasGap: false };
    d.wh += i.wh;
    d.hours += i.hours;
    d.hasGap ||= i.gap;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}
