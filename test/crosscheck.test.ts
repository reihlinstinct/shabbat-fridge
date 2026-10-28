import { describe, expect, it } from 'vitest';
import { computeBlocks } from '../src/blocks.js';
import { compareYomTov, crossCheckOrThrow, hebcalYomTovDays, yomTovDaysOf } from '../src/crosscheck.js';

const JERUSALEM = { latitude: 31.76904, longitude: 35.21633, tzid: 'Asia/Jerusalem', israel: true };
const fake = (items: Array<{ date: string; title: string; yomtov?: boolean }>) => async () => new Response(JSON.stringify({ items }), { status: 200 });

describe('Hebcal cross-check', () => {
  const blocks = computeBlocks(JERUSALEM, new Date(2027, 3, 1), new Date(2027, 5, 30));
  it('our Yom Tov days exclude plain Shabbat', () => {
    expect([...yomTovDaysOf(blocks)].sort()).toEqual(['2027-04-22', '2027-04-28', '2027-06-11']);
  });
  it('passes when the API agrees', async () => {
    const f = fake([{ date: '2027-04-22', title: 'Pesach I', yomtov: true }, { date: '2027-04-28', title: 'Pesach VII', yomtov: true }, { date: '2027-06-11', title: 'Shavuot', yomtov: true }, { date: '2027-04-26', title: 'Pesach IV (CH"M)', yomtov: false }]);
    expect(await crossCheckOrThrow(blocks, true, '2027-04-01', '2027-06-30', true, f)).toBe(3);
  });
  it('throws and names the difference when the API disagrees', async () => {
    const f = fake([{ date: '2027-04-22', title: 'Pesach I', yomtov: true }, { date: '2027-04-28', title: 'Pesach VII', yomtov: true }, { date: '2027-06-12', title: 'Shavuot II', yomtov: true }]);
    await expect(crossCheckOrThrow(blocks, true, '2027-04-01', '2027-06-30', true, f)).rejects.toThrow(/only ours: 2027-06-11; only Hebcal: 2027-06-12/i);
  });
  it('can drop Yom Kippur and reports API errors', async () => {
    const f = fake([{ date: '2027-10-11', title: 'Yom Kippur', yomtov: true }]);
    expect((await hebcalYomTovDays(true, 2027, 2027, f, false)).size).toBe(0);
    await expect(hebcalYomTovDays(true, 2027, 2027, async () => new Response('x', { status: 500 }))).rejects.toThrow(/HTTP 500/);
  });
  it('compare ignores days outside the range', () => {
    expect(compareYomTov(new Set(['2027-01-01']), new Set(['2028-01-01']), '2027-04-01', '2027-06-30')).toEqual({ onlyOurs: [], onlyHebcal: [] });
  });
});
