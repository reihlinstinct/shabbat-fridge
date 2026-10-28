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
