import { describe, expect, it } from 'vitest';
import fixture from './fixtures/hebcal-yomtov.json';
import { computeBlocks, type Place } from '../src/blocks.js';
import { yomTovDaysOf } from '../src/crosscheck.js';
import { entriesOf, holidayOnlyActions, rulesByYear, type Entry } from '../src/rules.js';

/**
 * Independent oracle. The Yom Tov dates come from a pinned Hebcal fixture (100 years, both calendars), not from our
 * calendar core. Expected rule entries are derived from those dates with plain day arithmetic only.
 */
const JERUSALEM: Place = { latitude: 31.769, longitude: 35.216, tzid: 'Asia/Jerusalem', israel: true };
const DEVICE = 'TEST-DEVICE';
const OPTS = { deviceId: DEVICE, entryMinutesBeforeSunset: 60, exitMinutesAfterSunset: 90, reenterMinutesAfterSunset: 100 };
const FROM = new Date(fixture.firstYear, 0, 1);
const TO = new Date(fixture.lastYear, 11, 31);

const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s: string): Date => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const addDays = (s: string, n: number): string => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const isSat = (s: string): boolean => parse(s).getDay() === 6;

/** Runs of consecutive no-work days (Yom Tov or Saturday) that contain at least one Yom Tov day. */
function oracleRuns(yomtov: Set<string>): string[][] {
  const days = new Set(yomtov);
  for (let d = parse(`${fixture.firstYear}-01-01`); d <= TO; d.setDate(d.getDate() + 1)) if (d.getDay() === 6) days.add(iso(d));
  const sorted = [...days].sort();
  const runs: string[][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[last.length - 1]!, 1) === d) last.push(d);
    else runs.push([d]);
  }
  return runs.filter((r) => r.some((d) => yomtov.has(d)));
}

/** Expected companion entries for a run: ON eve -60 (unless first day is Saturday), re-ON +100 on Saturdays inside, OFF +90 (unless last is Saturday). */
function expectedEntries(run: string[]): Entry[] {
  const out: Entry[] = [];
  const first = run[0]!;
  const last = run[run.length - 1]!;
  if (!isSat(first)) out.push({ date: addDays(first, -1), offset: -60, command: 'on' });
  for (const d of run) if (isSat(d) && d !== last) out.push({ date: d, offset: 100, command: 'on' });
  if (!isSat(last)) out.push({ date: last, offset: 90, command: 'off' });
  return out;
}
const k = (e: Entry): string => `${e.date} ${e.command} ${e.offset}`;

// small seeded PRNG so the random sample is reproducible
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

for (const cal of ['israel', 'diaspora'] as const) {
  describe(`100 years, ${cal} calendar`, () => {
    const place = { ...JERUSALEM, israel: cal === 'israel' };
    const fx = fixture[cal];
    const yomtov = new Set(fx.yomtov);
    const blocks = computeBlocks(place, FROM, TO, { entryMinutesBeforeSunset: 60, exitMinutesAfterSunset: 90, includeYomKippur: true });
    const actions = holidayOnlyActions(blocks, OPTS);
    const rules = rulesByYear('shabbat-fridge holidays', actions);
    const { dated } = entriesOf(rules, DEVICE);
    const want = oracleRuns(yomtov).flatMap(expectedEntries);

    it('calendar core agrees with Hebcal on every Yom Tov day, exhaustively', () => {
      const ours = yomTovDaysOf(blocks);
      expect([...ours].filter((d) => !yomtov.has(d))).toEqual([]);
      expect([...yomtov].filter((d) => !ours.has(d))).toEqual([]);
      expect(yomtov.size).toBeGreaterThan(cal === 'israel' ? 800 : 1300);
    });

    it('generated rules equal the oracle entries exactly (every holiday in 100 years)', () => {
      expect(dated.map(k).sort()).toEqual(want.map(k).sort());
    });

    it('covers the Saturday cases: Saturday-only Yom Tov gets no rule, Saturday inside a block gets a +100 re-ON', () => {
      const satOnly = [...yomtov].filter((d) => isSat(d) && !yomtov.has(addDays(d, -1)) && !yomtov.has(addDays(d, 1)));
      expect(satOnly.length).toBeGreaterThan(0);
      for (const d of satOnly) {
        const run = oracleRuns(yomtov).find((r) => r.includes(d))!;
        if (run.length === 1) expect(dated.filter((e) => e.date === d)).toEqual([]);
      }
      const reOn = dated.filter((e) => e.offset === 100 && e.command === 'on');
      expect(reOn.length).toBeGreaterThan(10);
      for (const e of reOn) expect(isSat(e.date)).toBe(true);
    });

    it('every OFF is +90 on a non-Saturday and every eve ON is -60 on the day before a Yom Tov or Sunday after Saturday', () => {
      for (const e of dated) {
        if (e.command === 'off') { expect(e.offset).toBe(90); expect(isSat(e.date)).toBe(false); expect(yomtov.has(e.date)).toBe(true); }
        if (e.command === 'on' && e.offset === -60) expect(yomtov.has(addDays(e.date, 1))).toBe(true);
      }
    });

    it('generated JSON is well formed: names by year, Sunset/Minute, one device, valid unique dates', () => {
      const seen = new Set<string>();
      for (const r of rules) {
        expect(r.name).toMatch(/^shabbat-fridge holidays \d{4}$/);
        for (const a of r.actions) {
          const s = a.every.specific;
          expect(`shabbat-fridge holidays ${s.year}`).toBe(r.name);
          expect(s.reference).toBe('Sunset');
          expect(s.offset.unit).toBe('Minute');
          expect(iso(new Date(s.year, s.month - 1, s.day))).toBe(`${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`);
          expect(a.every.actions).toHaveLength(1);
          expect(a.every.actions[0]!.command.devices).toEqual([DEVICE]);
          const key = `${s.year}-${s.month}-${s.day} ${s.offset.value.integer}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    });

    it('seeded random holidays over 100 years, plus one per year of the first 10 years, get the expected rule entries', () => {
      const all = [...yomtov].sort();
      const rnd = mulberry32(20261028);
      const sample = Array.from({ length: 200 }, () => all[Math.floor(rnd() * all.length)]!);
      for (let y = 2027; y <= 2036; y++) {
        const inYear = all.filter((d) => d.startsWith(`${y}-`));
        sample.push(inYear[Math.floor(rnd() * inYear.length)]!);
      }
      const runs = oracleRuns(yomtov);
      const have = new Set(dated.map(k));
      for (const d of sample) {
        const run = runs.find((r) => r.includes(d))!;
        for (const e of expectedEntries(run)) expect(have.has(k(e)), `${cal} ${d}: missing ${k(e)}`).toBe(true);
      }
    });
  });
}

describe('known fixed dates (Hebrew calendar, Israel)', () => {
  const { dated } = entriesOf(rulesByYear('x', holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2027, 0, 1), new Date(2028, 11, 31)), OPTS)), DEVICE);
  const has = (s: string): boolean => dated.map(k).includes(s);
  it('Rosh Hashana 5788 (Sat 2027-10-02 and Sun 2027-10-03): re-ON Saturday +100, OFF Sunday +90', () => {
    expect(has('2027-10-02 on 100')).toBe(true);
    expect(has('2027-10-03 off 90')).toBe(true);
  });
  it('Pesach 5787 first day Thursday 2027-04-22: ON Wednesday -60, OFF Thursday +90', () => {
    expect(has('2027-04-21 on -60')).toBe(true);
    expect(has('2027-04-22 off 90')).toBe(true);
  });
});

describe('known fixed dates (Hebrew calendar, Diaspora)', () => {
  const { dated } = entriesOf(rulesByYear('x', holidayOnlyActions(computeBlocks({ ...JERUSALEM, israel: false }, new Date(2027, 0, 1), new Date(2028, 11, 31)), OPTS)), DEVICE);
  const has = (s: string): boolean => dated.map(k).includes(s);
  it('Shemini Atzeret Sat 2027-10-23 + Simchat Torah Sun 2027-10-24: re-ON Saturday +100, OFF Sunday +90', () => {
    expect(has('2027-10-23 on 100')).toBe(true);
    expect(has('2027-10-24 off 90')).toBe(true);
  });
  it('Pesach 2027 Thu 04-22 + Fri 04-23 (Pesach II) run into Shabbat: ON Wednesday, no OFF Thursday or Friday', () => {
    expect(has('2027-04-21 on -60')).toBe(true);
    expect(has('2027-04-22 off 90')).toBe(false);
    expect(has('2027-04-23 off 90')).toBe(false);
  });
});
