import { describe, expect, it } from 'vitest';
import { computeBlocks, type Place } from '../src/blocks.js';
import { MANAGED_NAME, planInstall, type ExistingRule } from '../src/install.js';
import { entriesOf, holidayOnlyActions, lateWeeklyOffs, rulesByYear, weeklyRule, WEEKLY_RULE_NAME, type Rule } from '../src/rules.js';

const D = 'DEV';
const JERUSALEM: Place = { latitude: 31.769, longitude: 35.216, tzid: 'Asia/Jerusalem', israel: true };

describe('weeklyRule', () => {
  it('Friday ON at sunset-60 and Saturday OFF at sunset+90 by default, one rule, Sunset reference', () => {
    const r = weeklyRule({ deviceId: D });
    expect(r.name).toBe('shabbat-fridge weekly');
    expect(entriesOf([r], D).weekly).toEqual(['Fri on -60', 'Sat off +90']);
    for (const a of r.actions) {
      expect(a.every.specific.reference).toBe('Sunset');
      expect(a.every.specific.offset.unit).toBe('Minute');
      expect(a.every.actions[0]!.command.devices).toEqual([D]);
    }
  });
  it('offsets are configurable', () => {
    expect(entriesOf([weeklyRule({ deviceId: D, entryMinutesBeforeSunset: 30, exitMinutesAfterSunset: 75 })], D).weekly).toEqual(['Fri on -30', 'Sat off +75']);
  });
  it('refuses a Saturday OFF at or after the holiday re-ON (it would undo the re-ON)', () => {
    expect(() => weeklyRule({ deviceId: D, exitMinutesAfterSunset: 100 })).toThrow(/before the holiday re-ON/);
    expect(() => weeklyRule({ deviceId: D, exitMinutesAfterSunset: 120, reenterMinutesAfterSunset: 100 })).toThrow();
    expect(() => weeklyRule({ deviceId: D, exitMinutesAfterSunset: 110, reenterMinutesAfterSunset: 130 })).not.toThrow();
  });
  it('interplay: for every Saturday re-ON the weekly OFF fires earlier the same evening', () => {
    const acts = holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2027, 0, 1), new Date(2030, 11, 31)), { deviceId: D });
    const reOn = entriesOf([{ name: 'x', actions: acts }], D).dated.filter((e) => e.command === 'on' && e.offset === 100);
    expect(reOn.length).toBeGreaterThan(0);
    const weeklyOff = Number(/\+(\d+)$/.exec(entriesOf([weeklyRule({ deviceId: D })], D).weekly[1]!)![1]);
    for (const e of reOn) expect(weeklyOff).toBeLessThan(e.offset);
  });
});

describe('planInstall with the weekly rule', () => {
  const weekly = weeklyRule({ deviceId: D });
  const holiday = rulesByYear('shabbat-fridge holidays', holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2027, 0, 1), new Date(2028, 11, 31)), { deviceId: D }));
  const mine = (name: string): ExistingRule => ({ id: `id-${name}`, name, actions: [] });

  it('the weekly name is managed', () => {
    expect(MANAGED_NAME.test(WEEKLY_RULE_NAME)).toBe(true);
    expect(MANAGED_NAME.test('shabbat-fridge weekly 2')).toBe(false);
  });
  it('creates the weekly rule once and is then idempotent', () => {
    const p1 = planInstall([], [weekly, ...holiday]);
    expect(p1.create.map((r) => r.name)).toContain('shabbat-fridge weekly');
    const after: ExistingRule[] = [weekly, ...holiday].map((r, i) => ({ ...r, id: `n${i}` }));
    const p2 = planInstall(after, [weekly, ...holiday]);
    expect(p2.create.length + p2.update.length + p2.remove.length).toBe(0);
  });
  it("never touches the user's own weekly rules (they stay in untouched)", () => {
    const own = [mine('Shabbat mode'), mine('Weekday Mode')];
    const p = planInstall(own, [weekly, ...holiday]);
    expect(p.untouched).toEqual(['Shabbat mode', 'Weekday Mode']);
    expect(p.remove).toEqual([]);
    expect(p.update).toEqual([]);
  });
  it('prune removes old holiday-year rules but never the weekly rule', () => {
    const existing: ExistingRule[] = [{ ...weekly, id: 'w' }, mine('shabbat-fridge holidays 2020')];
    const p = planInstall(existing, holiday, true);
    expect(p.remove.map((r) => r.name)).toEqual(['shabbat-fridge holidays 2020']);
  });
});

describe('lateWeeklyOffs (the user already has their own weekly OFF)', () => {
  const own = (offset: number): Rule => ({ ...weeklyRule({ deviceId: D, exitMinutesAfterSunset: 90 }), name: 'Weekday Mode', actions: [{ ...weeklyRule({ deviceId: D, exitMinutesAfterSunset: 90 }).actions[1]! }] }) as Rule & { name: string };
  it('flags a Saturday OFF at or after +100, ignores +90', () => {
    const late = weeklyRule({ deviceId: D, exitMinutesAfterSunset: 95, reenterMinutesAfterSunset: 200 });
    const adj = JSON.parse(JSON.stringify(late.actions[1])) as Rule['actions'][number];
    (adj.every.specific.offset.value as { integer: number }).integer = 120;
    expect(lateWeeklyOffs([{ name: 'o', actions: [adj] }], D, 100)).toEqual(['Sat off +120']);
    expect(lateWeeklyOffs([own(90)], D, 100)).toEqual([]);
  });
});
