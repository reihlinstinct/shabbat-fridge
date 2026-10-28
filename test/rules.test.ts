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
});
