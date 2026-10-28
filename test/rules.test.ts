import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeBlocks, type Place } from '../src/blocks.js';
import { blocksToActions, buildRule, diffRules, entriesOf, type Rule } from '../src/rules.js';

const JERUSALEM: Place = { latitude: 31.76904, longitude: 35.21633, tzid: 'Asia/Jerusalem', israel: true };
const existing = JSON.parse(readFileSync(new URL('./fixtures/existing-rules.json', import.meta.url), 'utf8')) as Rule[];

describe('blocksToActions', () => {
  it('Rosh Hashana 5787 (Sat+Sun): ON Friday eve, one OFF Sunday only', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2026, 8, 10), new Date(2026, 8, 14));
    const { dated } = entriesOf([buildRule('t', blocks, { deviceId: 'D', entryMinutesBeforeSunset: 10, exitMinutesAfterSunset: 40 })], 'D');
    expect(dated).toEqual([
      { date: '2026-09-11', offset: -10, command: 'on' },
      { date: '2026-09-13', offset: 40, command: 'off' },
    ]);
  });

  it('eve of Shabbat 2028-01-01 falls in the previous year', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2028, 0, 1), new Date(2028, 0, 1));
    const acts = blocksToActions(blocks, { deviceId: 'D' });
    expect(acts[0]!.every.specific).toMatchObject({ year: 2027, month: 12, day: 31 });
    expect(acts[1]!.every.specific).toMatchObject({ year: 2028, month: 1, day: 1 });
  });

  it('emits the capability and device exactly like SmartThings Rules JSON', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2026, 9, 10), new Date(2026, 9, 10));
    const [on] = blocksToActions(blocks, { deviceId: 'D' });
    expect(on!.every.actions[0]!.command).toEqual({
      devices: ['D'],
      commands: [{ component: 'main', capability: 'samsungce.sabbathMode', command: 'on' }],
    });
  });
});

describe('diffRules (dry run)', () => {
  it('flags the weekly Saturday OFF that would end a Sat+Sun holiday early', () => {
    const blocks = computeBlocks(JERUSALEM, new Date(2026, 8, 10), new Date(2026, 8, 14));
    const diff = diffRules(existing, blocksToActions(blocks, { deviceId: 'FRIDGE', entryMinutesBeforeSunset: 40 }), 'FRIDGE');
    expect(diff.weeklyRules).toContain('Sat off +90');
    expect(diff.missing).toEqual(['2026-09-13 off +40']);
    expect(diff.extra).toEqual([]);
  });

  it('reports existing dated entries that are no longer wanted', () => {
    const diff = diffRules(existing, [], 'FRIDGE');
    expect(diff.extra).toEqual(['2026-09-11 on -40']);
  });

  it('counts actions it ignores (other reference or other device)', () => {
    const other: Rule[] = [
      { name: 'x', actions: [{ every: { specific: { year: 2026, month: 1, day: 1, reference: 'Noon' as 'Sunset', offset: { value: { integer: 0 }, unit: 'Minute' } }, actions: [{ command: { devices: ['FRIDGE'], commands: [{ component: 'main', capability: 'samsungce.sabbathMode', command: 'on' }] } }] } }] },
      { name: 'y', actions: [{ every: { specific: { year: 2026, month: 1, day: 1, reference: 'Sunset', offset: { value: { integer: 0 }, unit: 'Minute' } }, actions: [{ command: { devices: ['OTHER'], commands: [{ component: 'main', capability: 'samsungce.sabbathMode', command: 'on' }] } }] } }] },
    ];
    expect(diffRules(other, [], 'FRIDGE').skipped).toBe(2);
  });
});

import { holidayOnlyActions, rulesByYear } from '../src/rules.js';

const summary = (acts: ReturnType<typeof holidayOnlyActions>): string[] =>
  entriesOf([{ name: 't', actions: acts }], 'D').dated.map((e) => `${e.date} ${e.command} ${e.offset}`);
const HO = { deviceId: 'D', entryMinutesBeforeSunset: 60, exitMinutesAfterSunset: 90, reenterMinutesAfterSunset: 100 };

describe('holidayOnlyActions (weekly Friday ON / Saturday OFF stay in place)', () => {
  it('plain Shabbat produces nothing', () => {
    expect(holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2026, 9, 9), new Date(2026, 9, 10)), HO)).toEqual([]);
  });

  it('Rosh Hashana Sat+Sun 2026: no ON (Friday weekly covers), re-ON Saturday +100, OFF Sunday +90', () => {
    const acts = holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2026, 8, 10), new Date(2026, 8, 14)), HO);
    expect(summary(acts)).toEqual(['2026-09-12 on 100', '2026-09-13 off 90']);
  });

  it('Shavuot Fri + Shabbat 2027: ON Thursday eve, nothing else (the weekly OFF ends it)', () => {
    const acts = holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2027, 5, 9), new Date(2027, 5, 13)), HO);
    expect(summary(acts)).toEqual(['2027-06-10 on -60']);
  });

  it('Pesach I Thursday 2027-04-22: ON Wednesday eve, OFF Thursday +90', () => {
    const acts = holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2027, 3, 20), new Date(2027, 3, 22)), HO);
    expect(summary(acts)).toEqual(['2027-04-21 on -60', '2027-04-22 off 90']);
  });

  it('Shmini Atzeret on Saturday 2026-10-03: nothing (weekly Friday ON and Saturday OFF cover it)', () => {
    expect(holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2026, 9, 1), new Date(2026, 9, 5)), HO)).toEqual([]);
  });

  it('Sunday Yom Tov after Shabbat (Sat+Sun block) re-enters, a Yom Tov Sun+Mon block too', () => {
    // Diaspora Rosh Hashana 5788: Fri 2027-10-01 eve, Sat+Sun 2027-10-02/03 would be Israel; use Diaspora Shmini Atzeret 2026
    const acts = holidayOnlyActions(computeBlocks({ ...JERUSALEM, israel: false }, new Date(2026, 9, 1), new Date(2026, 9, 5)), HO);
    expect(summary(acts)).toEqual(['2026-10-03 on 100', '2026-10-04 off 90']);
  });

  it('rulesByYear groups by the action year', () => {
    const acts = holidayOnlyActions(computeBlocks(JERUSALEM, new Date(2026, 8, 1), new Date(2027, 5, 30)), HO);
    const rules = rulesByYear('shabbat-fridge', acts);
    expect(rules.map((r) => r.name)).toEqual(['shabbat-fridge 2026', 'shabbat-fridge 2027']);
  });
});
