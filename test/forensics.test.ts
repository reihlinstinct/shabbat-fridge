import { describe, expect, it } from 'vitest';
import { computeBlocks, type Place } from '../src/blocks.js';
import { analyze, maxGapMinutes, summarize, transitionsFrom, type Snapshot } from '../src/forensics.js';

const JERUSALEM: Place = { latitude: 31.769, longitude: 35.216, tzid: 'Asia/Jerusalem', israel: true };
// Shabbat of 2026-10-23/24 as one block: ON at Friday sunset-60, OFF at Saturday sunset+90.
const blocks = computeBlocks(JERUSALEM, new Date(2026, 9, 23), new Date(2026, 9, 24), { entryMinutesBeforeSunset: 60, exitMinutesAfterSunset: 90 });
const b = blocks[0]!;
const min = (d: Date, m: number): Date => new Date(d.getTime() + m * 60000);
const snap = (at: Date, v: 'on' | 'off' | null, changed?: Date): Snapshot => ({ takenAt: at.toISOString(), sabbath: v && changed ? { value: v, timestamp: changed.toISOString() } : null });

/** Snapshots every 30 minutes from 2 hours before the block to 2 hours after, given the change events. */
function run(changes: Array<[Date, 'on' | 'off']>): Snapshot[] {
  const snaps: Snapshot[] = [];
  const t0 = min(b.start, -120);
  const t1 = min(b.end, 120);
  for (let t = t0; t <= t1; t = min(t, 30)) {
    let last: [Date, 'on' | 'off'] | undefined;
    for (const c of changes) if (c[0] <= t) last = c;
    snaps.push(snap(t, last ? last[1] : null, last ? last[0] : undefined));
  }
  return snaps;
}

describe('collector analysis', () => {
  it('the block is the expected Shabbat of Saturday 2026-10-24 (ON the evening before)', () => {
    expect(b.days).toEqual(['2026-10-24']);
    expect((b.end.getTime() - b.start.getTime()) / 3600000).toBeGreaterThan(26);
  });
  it('on schedule: ok', () => {
    const f = analyze(run([[min(b.start, 0), 'on'], [min(b.end, 1), 'off']]), blocks);
    expect(f.map((x) => x.kind)).toEqual(['ok']);
  });
  it('turned off mid-Shabbat: early-exit with minutes before the scheduled end', () => {
    const f = analyze(run([[min(b.start, 0), 'on'], [min(b.end, -600), 'off']]), blocks);
    expect(f.find((x) => x.kind === 'early-exit')?.minutes).toBe(-600);
  });
  it('never turned on: missed-on', () => {
    const f = analyze(run([[min(b.start, -600), 'off']]), blocks);
    expect(f.map((x) => x.kind)).toContain('missed-on');
  });
  it('turned on late: missed-on with the delay', () => {
    const f = analyze(run([[min(b.start, 90), 'on'], [min(b.end, 1), 'off']]), blocks);
    expect(f.find((x) => x.kind === 'missed-on')?.minutes).toBe(90);
  });
  it('still on after the scheduled OFF: late-exit', () => {
    const f = analyze(run([[min(b.start, 0), 'on']]), blocks);
    expect(f.map((x) => x.kind)).toContain('late-exit');
  });
  it('turned on outside any block: unexplained-on', () => {
    const snaps = run([[min(b.start, 0), 'on'], [min(b.end, 1), 'off']]);
    const extra = min(b.end, 100);
    snaps.push(snap(min(extra, 10), 'on', extra));
    expect(analyze(snaps, blocks).map((x) => x.kind)).toContain('unexplained-on');
  });
  it('snapshots that do not cover the block: not-covered, no verdict', () => {
    const f = analyze([snap(min(b.start, 60), 'on', min(b.start, 0))], blocks);
    expect(f.map((x) => x.kind)).toEqual(['not-covered']);
  });
  it('transitions are deduplicated and the gap is reported', () => {
    const s = run([[min(b.start, 0), 'on'], [min(b.end, 1), 'off']]);
    expect(transitionsFrom(s)).toHaveLength(2);
    expect(maxGapMinutes(s)).toBe(30);
  });
  it('summary has counts only (no timestamps or ids)', () => {
    const out = summarize(analyze(run([[min(b.start, 0), 'on'], [min(b.end, -600), 'off']]), blocks));
    expect(out).toMatch(/^[a-z-]+: \d+(, [a-z-]+: \d+)*$/);
    expect(out).not.toMatch(/\d{4}-\d\d-\d\d|[0-9a-f]{8}-/);
  });
});

import { companionGaps } from '../src/forensics.js';
import { sunset } from '../src/blocks.js';

describe('holiday companion schedule (Saturday OFF at +90 then re-ON at +100)', () => {
  // Rosh Hashana 5788: Saturday 2027-10-02 and Sunday 2027-10-03 in Israel, one block.
  const hb = computeBlocks(JERUSALEM, new Date(2027, 9, 1), new Date(2027, 9, 4), { entryMinutesBeforeSunset: 60, exitMinutesAfterSunset: 90 })[0]!;
  const gapsOf = (x: typeof hb) => companionGaps(x, (d) => sunset(JERUSALEM, d), 90, 100);
  const sat = sunset(JERUSALEM, new Date(2027, 9, 2));
  function runH(changes: Array<[Date, 'on' | 'off']>): Snapshot[] {
    const snaps: Snapshot[] = [];
    for (let t = min(hb.start, -120); t <= min(hb.end, 120); t = min(t, 5)) {
      let last: [Date, 'on' | 'off'] | undefined;
      for (const c of changes) if (c[0] <= t) last = c;
      snaps.push(snap(t, last ? last[1] : null, last ? last[0] : undefined));
    }
    return snaps;
  }
  it('the block spans Friday eve to Sunday and has one expected 10-minute gap on Saturday evening', () => {
    expect(hb.days).toEqual(['2027-10-02', '2027-10-03']);
    const g = gapsOf(hb);
    expect(g).toHaveLength(1);
    expect((g[0]!.to.getTime() - g[0]!.from.getTime()) / 60000).toBe(10);
  });
  const normal: Array<[Date, 'on' | 'off']> = [[min(hb.start, 0), 'on'], [min(sat, 90), 'off'], [min(sat, 100), 'on'], [min(hb.end, 1), 'off']];
  it('normal: the Saturday OFF and re-ON are not an early exit', () => {
    expect(analyze(runH(normal), [hb], 15, gapsOf).map((x) => x.kind)).toEqual(['ok']);
  });
  it('missing re-ON: reported as missed-reon (and the later OFF is not flagged early)', () => {
    const f = analyze(runH([[min(hb.start, 0), 'on'], [min(sat, 90), 'off']]), [hb], 15, gapsOf);
    expect(f.map((x) => x.kind)).toEqual(['missed-reon']);
  });
  it('a real early exit on Sunday morning is still flagged', () => {
    const f = analyze(runH([...normal.slice(0, 3), [min(hb.end, -600), 'off']] as Array<[Date, 'on' | 'off']>), [hb], 15, gapsOf);
    expect(f.map((x) => x.kind)).toContain('early-exit');
  });
  it('without the companion model the Saturday OFF would be an early exit (proves the model matters)', () => {
    expect(analyze(runH(normal), [hb], 15).map((x) => x.kind)).toContain('early-exit');
  });
  it('missed-on is bounded to its own block (a later block ON does not count)', () => {
    const next = computeBlocks(JERUSALEM, new Date(2027, 9, 8), new Date(2027, 9, 10), { entryMinutesBeforeSunset: 60, exitMinutesAfterSunset: 90 })[0]!;
    const snaps = runH([[min(hb.start, -600), 'off']]);
    snaps.push(snap(min(next.start, 5), 'on', next.start));
    const f = analyze(snaps, [hb], 15, gapsOf).find((x) => x.kind === 'missed-on');
    expect(f?.minutes).toBeUndefined();
    expect(f?.detail).toMatch(/never turned on/);
  });
});
