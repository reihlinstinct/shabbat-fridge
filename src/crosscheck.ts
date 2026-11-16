import type { Block } from './blocks.js';
import type { Fetch } from './smartthings.js';

export interface CrossCheck {
  /** Yom Tov days our calendar core produced that Hebcal's web API did not list. */
  onlyOurs: string[];
  /** Yom Tov days Hebcal's web API listed that we did not produce. */
  onlyHebcal: string[];
}

/** Yom Tov days (not plain Shabbat) in the blocks. */
export function yomTovDaysOf(blocks: Block[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) b.days.forEach((day, i) => { if (b.reasons[i] !== 'Shabbat') out.add(day); });
  return out;
}

/** Ask Hebcal's public API for Yom Tov days of each year in range. Israel flag selects 1 day or 2 days. */
export async function hebcalYomTovDays(israel: boolean, fromYear: number, toYear: number, fetcher: Fetch = fetch, includeYomKippur = true): Promise<Set<string>> {
  const out = new Set<string>();
  for (let y = fromYear; y <= toYear; y++) {
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=off&nx=off&ss=off&mf=off&year=${y}&month=x&i=${israel ? 'on' : 'off'}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`Hebcal API HTTP ${res.status} for ${y}`);
    const body = (await res.json()) as { items?: Array<{ date: string; title: string; yomtov?: boolean }> };
    for (const it of body.items ?? []) {
      if (!it.yomtov) continue;
      if (!includeYomKippur && it.title === 'Yom Kippur') continue;
      out.add(it.date.slice(0, 10));
    }
  }
  return out;
}

export function compareYomTov(ours: Set<string>, theirs: Set<string>, from: string, to: string): CrossCheck {
  const inRange = (d: string): boolean => d >= from && d <= to;
  return {
    onlyOurs: [...ours].filter((d) => inRange(d) && !theirs.has(d)).sort(),
    onlyHebcal: [...theirs].filter((d) => inRange(d) && !ours.has(d)).sort(),
  };
}

/** Throws if our calendar and Hebcal's API disagree on any Yom Tov day in [from, to] (YYYY-MM-DD). */
export async function crossCheckOrThrow(blocks: Block[], israel: boolean, from: string, to: string, includeYomKippur = true, fetcher: Fetch = fetch): Promise<number> {
  const theirs = await hebcalYomTovDays(israel, Number(from.slice(0, 4)), Number(to.slice(0, 4)), fetcher, includeYomKippur);
  const diff = compareYomTov(yomTovDaysOf(blocks), theirs, from, to);
  if (diff.onlyOurs.length || diff.onlyHebcal.length) {
    throw new Error(`Calendar mismatch with Hebcal API. Only ours: ${diff.onlyOurs.join(',') || '-'}; only Hebcal: ${diff.onlyHebcal.join(',') || '-'}`);
  }
  return [...theirs].filter((d) => d >= from && d <= to).length;
}
