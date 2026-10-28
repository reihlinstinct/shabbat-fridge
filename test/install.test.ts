import { describe, expect, it } from 'vitest';
import { isEmpty, planInstall, type ExistingRule } from '../src/install.js';
import type { Rule } from '../src/rules.js';
import { SmartThings, sabbathDevices } from '../src/smartthings.js';

const rule = (name: string, n = 1): Rule => ({
  name,
  actions: Array.from({ length: n }, (_, i) => ({
    every: {
      specific: { year: 2027, month: 4, day: 20 + i, reference: 'Sunset' as const, offset: { value: { integer: -60 }, unit: 'Minute' as const } },
      actions: [{ command: { devices: ['D'], commands: [{ component: 'main', capability: 'samsungce.sabbathMode', command: 'on' as const }] } }],
    },
  })),
});
const ex = (name: string, id: string, n = 1): ExistingRule => ({ ...rule(name, n), id });

describe('planInstall', () => {
  it('creates missing, leaves equal, updates changed, never touches other rules', () => {
    const existing = [ex('Shabbat mode', 'a'), ex('Weekday Mode', 'b'), ex('shabbat-fridge holidays 2027', 'c', 1), ex('shabbat-fridge holidays 2028', 'd', 1)];
    const desired = [rule('shabbat-fridge holidays 2027', 1), rule('shabbat-fridge holidays 2028', 2), rule('shabbat-fridge holidays 2029', 1)];
    const p = planInstall(existing, desired);
    expect(p.unchanged).toEqual(['shabbat-fridge holidays 2027']);
    expect(p.update.map((u) => u.id)).toEqual(['d']);
    expect(p.create.map((r) => r.name)).toEqual(['shabbat-fridge holidays 2029']);
    expect(p.remove).toEqual([]);
    expect(p.untouched).toEqual(['Shabbat mode', 'Weekday Mode']);
  });

  it('is idempotent: planning against the result of the plan is empty', () => {
    const desired = [rule('shabbat-fridge holidays 2027', 2)];
    const first = planInstall([], desired);
    const after: ExistingRule[] = first.create.map((r, i) => ({ ...r, id: `n${i}` }));
    expect(isEmpty(planInstall(after, desired))).toBe(true);
  });

  it('removes only managed rules, only with prune, and duplicates of a managed name', () => {
    const existing = [ex('Holidays 2026', 'h'), ex('shabbat-fridge holidays 2026', 'o'), ex('shabbat-fridge holidays 2027', 'c'), ex('shabbat-fridge holidays 2027', 'c2')];
    const desired = [rule('shabbat-fridge holidays 2027')];
    expect(planInstall(existing, desired).remove.map((r) => r.id)).toEqual(['c2']);
    expect(planInstall(existing, desired, true).remove.map((r) => r.id).sort()).toEqual(['c2', 'o']);
    expect(planInstall(existing, desired, true).remove.some((r) => r.id === 'h')).toBe(false);
  });

  it('refuses to manage a rule outside the managed name pattern', () => {
    expect(() => planInstall([], [rule('Shabbat mode')])).toThrow(/refusing/);
  });
});

describe('SmartThings client', () => {
  it('sends the token only as a bearer header and keeps it out of errors', async () => {
    const secret = 'super-secret-token-123';
    let seen: Headers | undefined;
    const st = new SmartThings(secret, async (_url, init) => {
      seen = new Headers(init?.headers);
      return new Response(`{"error":"echo ${secret}"}`, { status: 401 });
    });
    await expect(st.locations()).rejects.toThrow(/HTTP 401/);
    await st.locations().catch((e: Error) => expect(e.message).not.toContain(secret));
    expect(seen!.get('authorization')).toBe(`Bearer ${secret}`);
  });

  it('rejects an empty token', () => {
    expect(() => new SmartThings('')).toThrow();
  });

  it('finds sabbath-capable devices in a location', () => {
    const devs = [
      { deviceId: '1', locationId: 'L', components: [{ id: 'main', capabilities: [{ id: 'samsungce.sabbathMode' }] }] },
      { deviceId: '2', locationId: 'L', components: [{ id: 'main', capabilities: [{ id: 'switch' }] }] },
      { deviceId: '3', locationId: 'X', components: [{ id: 'main', capabilities: [{ id: 'samsungce.sabbathMode' }] }] },
    ];
    expect(sabbathDevices(devs, 'L').map((d) => d.deviceId)).toEqual(['1']);
  });
});
