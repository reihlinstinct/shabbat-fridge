import { describe, expect, it } from 'vitest';
import { GAP_HOURS, intervalsOf, perDay } from '../src/energyseries.js';

const s = (takenAt: string, totalWh?: number) => ({ takenAt, energy: totalWh === undefined ? undefined : { totalWh } });

describe('intervalsOf', () => {
  it('computes Wh, hours and mean watts between consecutive snapshots, in time order', () => {
    const { intervals, skipped } = intervalsOf([s('2026-10-28T12:00:00.000Z', 1100), s('2026-10-28T10:00:00.000Z', 1000), s('2026-10-28T11:00:00.000Z', 1040)]);
    expect(skipped).toBe(0);
    expect(intervals.map((i) => [i.wh, i.hours, i.watts])).toEqual([[40, 1, 40], [60, 1, 60]]);
  });
  it('skips snapshots without a counter, a counter that went down and a repeated time, and counts them', () => {
    const r = intervalsOf([s('2026-10-28T10:00:00.000Z', 1000), s('2026-10-28T11:00:00.000Z'), s('2026-10-28T12:00:00.000Z', 900), s('2026-10-28T12:00:00.000Z', 950), s('bad', 5)]);
    expect(r.intervals).toHaveLength(0);
    expect(r.skipped).toBe(4);
  });
  it('marks an interval longer than the gap limit', () => {
    const r = intervalsOf([s('2026-10-28T10:00:00.000Z', 0), s(`2026-10-28T${10 + Math.ceil(GAP_HOURS) + 1}:00:00.000Z`, 100)]);
    expect(r.intervals[0]!.gap).toBe(true);
  });
  it('keeps a zero-Wh interval (a counter that did not move is valid)', () => {
    const r = intervalsOf([s('2026-10-28T10:00:00.000Z', 500), s('2026-10-28T11:00:00.000Z', 500)]);
    expect(r.skipped).toBe(0);
    expect(r.intervals.map((i) => [i.wh, i.watts])).toEqual([[0, 0]]);
  });
  it('treats exactly the gap limit as no gap and anything longer as a gap', () => {
    expect(intervalsOf([s('2026-10-28T10:00:00.000Z', 0), s('2026-10-28T12:30:00.000Z', 10)]).intervals[0]!.gap).toBe(false);
    expect(intervalsOf([s('2026-10-28T10:00:00.000Z', 0), s('2026-10-28T12:30:00.001Z', 10)]).intervals[0]!.gap).toBe(true);
  });
  it('computes mean watts as Wh per hour for an interval that is not one hour', () => {
    const r = intervalsOf([s('2026-10-28T10:00:00.000Z', 0), s('2026-10-28T10:30:00.000Z', 30)]);
    expect(r.intervals[0]).toMatchObject({ hours: 0.5, wh: 30, watts: 60 });
  });
  it('drops an unparsable time without letting it hide or create other intervals', () => {
    const r = intervalsOf([s('2026-10-28T10:00:00.000Z', 100), s('not a time', 50), s('2026-10-28T11:00:00.000Z', 140)]);
    expect(r.skipped).toBe(1);
    expect(r.intervals.map((i) => i.wh)).toEqual([40]);
  });
});

describe('perDay', () => {
  it('assigns an interval to the local day of its midpoint (Asia/Jerusalem, UTC+2 in late October)', () => {
    const r = intervalsOf([s('2026-10-28T21:00:00.000Z', 0), s('2026-10-28T23:00:00.000Z', 20), s('2026-10-29T01:00:00.000Z', 50)]);
    // midpoints 22:00Z (= 00:00 local on the 29th) and 00:00Z (= 02:00 local on the 29th): both on 2026-10-29
    expect(perDay(r.intervals, 'Asia/Jerusalem')).toEqual([{ day: '2026-10-29', wh: 50, hours: 4, hasGap: false }]);
    expect(perDay(r.intervals, 'UTC').map((d) => d.day)).toEqual(['2026-10-28', '2026-10-29']);
  });
  it('marks the day of a gap interval (by its midpoint) and not the others', () => {
    const r = intervalsOf([s('2026-10-28T08:00:00.000Z', 0), s('2026-10-28T09:00:00.000Z', 10), s('2026-10-29T08:00:00.000Z', 100), s('2026-10-29T09:00:00.000Z', 110)]);
    expect(perDay(r.intervals, 'UTC').map((d) => [d.day, d.hasGap])).toEqual([['2026-10-28', true], ['2026-10-29', false]]);
  });
});
