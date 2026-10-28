import { describe, expect, it } from 'vitest';
import { computeBlocks, sunset, type Place } from '../src/blocks.js';

const JERUSALEM: Place = { latitude: 31.76904, longitude: 35.21633, tzid: 'Asia/Jerusalem', israel: true };
const NEW_YORK: Place = { latitude: 40.7128, longitude: -74.006, tzid: 'America/New_York', israel: false };
const local = (d: Date, tz: string): string => d.toLocaleString('sv', { timeZone: tz });

describe('plain Shabbat', () => {
  it('Jerusalem 2026-10-09/10: on 10 min before sunset Friday, off 40 min after sunset Saturday', () => {
    const [b] = computeBlocks(JERUSALEM, new Date(2026, 9, 9), new Date(2026, 9, 10));
    expect(b!.days).toEqual(['2026-10-10']);
    expect(b!.reasons).toEqual(['Shabbat']);
    const fri = sunset(JERUSALEM, new Date(2026, 9, 9)).getTime();
    const sat = sunset(JERUSALEM, new Date(2026, 9, 10)).getTime();
    expect(fri - b!.start.getTime()).toBe(10 * 60000);
    expect(b!.end.getTime() - sat).toBe(40 * 60000);
    expect(local(b!.start, 'Asia/Jerusalem').slice(0, 10)).toBe('2026-10-09');
  });

  it('offsets are configurable', () => {
    const [b] = computeBlocks(JERUSALEM, new Date(2026, 9, 10), new Date(2026, 9, 10), {
      entryMinutesBeforeSunset: 40,
      exitMinutesAfterSunset: 72,
    });
    const fri = sunset(JERUSALEM, new Date(2026, 9, 9)).getTime();
    expect(fri - b!.start.getTime()).toBe(40 * 60000);
  });
});

describe('Yom Tov', () => {
  it('Rosh Hashana 5787 (Sat+Sun 2026-09-12/13) is a single block, no drop on Saturday night', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2026, 8, 10), new Date(2026, 8, 14));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.days).toEqual(['2026-09-12', '2026-09-13']);
    expect(blocks[0]!.end.getTime() - sunset(JERUSALEM, new Date(2026, 8, 13)).getTime()).toBe(40 * 60000);
    expect(blocks[0]!.start.getTime()).toBe(sunset(JERUSALEM, new Date(2026, 8, 11)).getTime() - 10 * 60000);
  });

  it('Hoshana Raba (Fri 2026-10-02, last day of Chol HaMoed) is not a block day; the block starts at its sunset for Shmini Atzeret', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2026, 9, 1), new Date(2026, 9, 2));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.days).toEqual(['2026-10-03']);
    expect(blocks.flatMap((b) => b.days)).not.toContain('2026-10-02');
    const eve = sunset(JERUSALEM, new Date(2026, 9, 2)).getTime();
    expect(eve - blocks[0]!.start.getTime()).toBe(10 * 60000);
    expect(local(blocks[0]!.start, 'Asia/Jerusalem').slice(0, 16)).toBe('2026-10-02 18:13');
  });

  it('Sukkot V (Wed 2026-09-30) is Chol HaMoed, no block', () => {
    expect(computeBlocks(JERUSALEM, new Date(2026, 8, 29), new Date(2026, 8, 30))).toEqual([]);
  });

  it('Israel: Shmini Atzeret and Simchat Torah are one day (2026-10-03, a Saturday)', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2026, 9, 1), new Date(2026, 9, 5));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.days).toEqual(['2026-10-03']);
    expect(blocks[0]!.reasons).toEqual(['Shmini Atzeret']);
  });

  it('Diaspora: same dates give two days (2026-10-03 and 2026-10-04)', () => {
    const blocks = computeBlocks({ ...JERUSALEM, israel: false }, new Date(2026, 9, 1), new Date(2026, 9, 5));
    expect(blocks[0]!.days).toEqual(['2026-10-03', '2026-10-04']);
  });

  it('Shavuot on Friday merges with Shabbat (2027-06-11/12)', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2027, 5, 9), new Date(2027, 5, 13));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.days).toEqual(['2027-06-11', '2027-06-12']);
    expect(blocks[0]!.reasons).toEqual(['Shavuot', 'Shabbat']);
    expect(blocks[0]!.end.getTime() - sunset(JERUSALEM, new Date(2027, 5, 12)).getTime()).toBe(40 * 60000);
  });

  it('Pesach I (Thu 2027-04-22) is its own block starting Wednesday evening', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2027, 3, 20), new Date(2027, 3, 22));
    expect(blocks[0]!.days).toEqual(['2027-04-22']);
    expect(local(blocks[0]!.start, 'Asia/Jerusalem').slice(0, 10)).toBe('2027-04-21');
  });

  it('Yom Kippur can be excluded', () => {
    const on = computeBlocks(JERUSALEM, new Date(2026, 8, 20), new Date(2026, 8, 22));
    const off = computeBlocks(JERUSALEM, new Date(2026, 8, 20), new Date(2026, 8, 22), { includeYomKippur: false });
    expect(on).toHaveLength(1);
    expect(off).toHaveLength(0);
  });
});

describe('location', () => {
  it('New York uses its own time zone and sunset', () => {
    const [b] = computeBlocks(NEW_YORK, new Date(2026, 11, 18), new Date(2026, 11, 19));
    expect(b!.days).toEqual(['2026-12-19']);
    const t = local(b!.start, 'America/New_York');
    expect(t.slice(0, 10)).toBe('2026-12-18');
    expect(t.slice(11, 13)).toBe('16');
  });

  it('DST change in Israel (clocks forward 2027-03-26) does not shift the sunset-relative offsets', () => {
    const [b] = computeBlocks(JERUSALEM, new Date(2027, 2, 27), new Date(2027, 2, 27));
    const fri = sunset(JERUSALEM, new Date(2027, 2, 26)).getTime();
    expect(fri - b!.start.getTime()).toBe(10 * 60000);
  });
});

describe('pinned values and calendar edge cases', () => {
  it('Jerusalem entry times match Hebcal published candle lighting (b=10) to the minute', () => {
    // Source: hebcal.com/hebcal?cfg=json&year=2026&month=10&c=on&geonameid=281184&b=10 (2026-10-28)
    const expected: Record<string, string> = { '2026-10-09': '18:04', '2026-10-16': '17:56', '2026-10-23': '17:48' };
    for (const [friday, hhmm] of Object.entries(expected)) {
      const [y, m, d] = friday.split('-').map(Number) as [number, number, number];
      const [b] = computeBlocks(JERUSALEM, new Date(y, m - 1, d + 1), new Date(y, m - 1, d + 1));
      expect(local(b!.start, 'Asia/Jerusalem').slice(0, 16)).toBe(`${friday} ${hhmm}`);
    }
  });

  it('New York sunset on 2026-12-18 is about 16:30 local', () => {
    const t = local(sunset(NEW_YORK, new Date(2026, 11, 18)), 'America/New_York');
    expect(t.slice(0, 10)).toBe('2026-12-18');
    expect(['16:29', '16:30', '16:31']).toContain(t.slice(11, 16));
  });

  it('Israel clocks go back 2026-10-25: Shabbat 2026-10-24 and 2026-10-31 keep exact offsets', () => {
    for (const day of [24, 31]) {
      const [b] = computeBlocks(JERUSALEM, new Date(2026, 9, day), new Date(2026, 9, day));
      expect(b!.days).toEqual([`2026-10-${day}`]);
      expect(sunset(JERUSALEM, new Date(2026, 9, day - 1)).getTime() - b!.start.getTime()).toBe(10 * 60000);
      expect(b!.end.getTime() - sunset(JERUSALEM, new Date(2026, 9, day)).getTime()).toBe(40 * 60000);
    }
  });

  it('New York clocks go back 2026-11-01: Shabbat 2026-10-31 ends before the change, offsets exact', () => {
    const [b] = computeBlocks(NEW_YORK, new Date(2026, 9, 31), new Date(2026, 9, 31));
    expect(local(b!.end, 'America/New_York').slice(0, 10)).toBe('2026-10-31');
    expect(b!.end.getTime() - sunset(NEW_YORK, new Date(2026, 9, 31)).getTime()).toBe(40 * 60000);
  });

  it('Diaspora Pesach 2027 (Thu, Fri, Shabbat) is one three-day block; Israel splits it', () => {
    const dia = computeBlocks({ ...JERUSALEM, israel: false }, new Date(2027, 3, 20), new Date(2027, 3, 25));
    expect(dia).toHaveLength(1);
    expect(dia[0]!.days).toEqual(['2027-04-22', '2027-04-23', '2027-04-24']);
    expect(dia[0]!.reasons).toEqual(['Pesach I', 'Pesach II', 'Shabbat']);
    const il = computeBlocks(JERUSALEM, new Date(2027, 3, 20), new Date(2027, 3, 25));
    expect(il.map((b) => b.days)).toEqual([['2027-04-22'], ['2027-04-24']]);
  });
});
