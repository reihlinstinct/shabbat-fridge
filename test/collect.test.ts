import { describe, expect, it } from 'vitest';
import { eventKey, isExpired, isMonthExpired, newEventLines, parseRetainDays } from '../src/collect.js';
import { SmartThings, type HistoryEvent } from '../src/smartthings.js';

const ev = (o: Partial<HistoryEvent>): HistoryEvent => ({ time: '2026-10-24T16:27:01.000+00:00', epoch: 1, hash: 7, capability: 'samsungce.sabbathMode', attribute: 'status', value: 'off', ...o });

describe('event dedupe', () => {
  it('same epoch and hash but a different capability, attribute or value are distinct events', () => {
    const keys = new Set([ev({}), ev({ value: 'on' }), ev({ attribute: 'other' }), ev({ capability: 'contactSensor' })].map(eventKey));
    expect(keys.size).toBe(4);
    expect(eventKey(ev({ component: 'main' }))).not.toBe(eventKey(ev({ component: 'cooler' })));
    expect(newEventLines(new Set(), [ev({ component: 'cooler' })])[0]!.line).toContain('"component":"cooler"');
  });
  it('only new events are returned, duplicates inside the batch are dropped, and re-runs add nothing', () => {
    const seen = new Set<string>();
    const first = newEventLines(seen, [ev({}), ev({}), ev({ value: 'on' })]);
    expect(first).toHaveLength(2);
    expect(newEventLines(seen, [ev({}), ev({ value: 'on' })])).toEqual([]);
    expect(newEventLines(seen, [ev({ epoch: 2 })])).toHaveLength(1);
  });
  it('events are filed under their own month', () => {
    expect(newEventLines(new Set(), [ev({ time: '2026-11-02T00:00:00.000+00:00' })])[0]!.month).toBe('2026-11');
  });
});

describe('retention', () => {
  it('RETAIN_DAYS must be a finite positive number', () => {
    expect(parseRetainDays('365')).toBe(365);
    for (const bad of ['', 'abc', '0', '-5', 'Infinity', 'NaN']) expect(() => parseRetainDays(bad)).toThrow();
  });
  const now = Date.parse('2026-10-28T12:00:00Z');
  it('snapshots expire by takenAt', () => {
    expect(isExpired('2025-10-01T00:00:00Z', now, 365)).toBe(true);
    expect(isExpired('2026-10-01T00:00:00Z', now, 365)).toBe(false);
    expect(isExpired('garbage', now, 365)).toBe(false);
  });
  it('an events month expires only after the whole month is older than the cutoff', () => {
    expect(isMonthExpired('2025-09', now, 365)).toBe(true);
    expect(isMonthExpired('2025-10', now, 365)).toBe(false);
  });
});

describe('deviceHistory pagination', () => {
  it('follows next links across pages, stops when empty, and sends the token only in the header', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const pages: Record<string, unknown> = {
      '/v1/history/devices?locationId=L&deviceId=D&limit=300': { items: [{ time: 'a' }, { time: 'b' }], _links: { next: { href: 'https://api.smartthings.com/history/devices?pagingBeforeEpoch=5&limit=100&locationId=L&deviceId=D' } } },
      '/v1/history/devices?pagingBeforeEpoch=5&limit=100&locationId=L&deviceId=D': { items: [{ time: 'c' }], _links: { next: { href: 'https://api.smartthings.com/history/devices?pagingBeforeEpoch=9&limit=100&locationId=L&deviceId=D' } } },
      '/v1/history/devices?pagingBeforeEpoch=9&limit=100&locationId=L&deviceId=D': { items: [], _links: {} },
    };
    const fetcher = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
      const body = pages[u.pathname + u.search];
      if (!body) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const out = await new SmartThings('SECRET-TOKEN', fetcher).deviceHistory('L', 'D');
    expect(out.map((e) => e.time)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(3);
    for (const c of calls) { expect(c.url).not.toContain('SECRET-TOKEN'); expect(c.auth).toBe('Bearer SECRET-TOKEN'); expect(c.url.startsWith('https://api.smartthings.com/v1/')).toBe(true); }
  });
  it('respects maxPages', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ items: [{ time: 'x' }], _links: { next: { href: 'https://api.smartthings.com/history/devices?p=1' } } }), { status: 200 })) as typeof fetch;
    expect((await new SmartThings('t', fetcher).deviceHistory('L', 'D', 3))).toHaveLength(3);
  });
});

describe('error hygiene', () => {
  it('a 200 response that is not JSON never leaks its body in the error', async () => {
    const canary = 'CANARY-TOKEN-9f3a';
    const fetcher = (async () => new Response(`${canary}{not json`, { status: 200 })) as typeof fetch;
    const st = new SmartThings('t', fetcher);
    for (const run of [() => st.locations(), () => st.deviceHistory('L', 'D'), () => st.deviceStatus('D')]) {
      try { await run(); throw new Error('should have thrown'); } catch (e) { expect(String(e)).not.toContain(canary); expect(String(e)).toMatch(/non-JSON response/); }
    }
  });
  it('an HTTP error never includes the body either', async () => {
    const fetcher = (async () => new Response('CANARY-BODY', { status: 500 })) as typeof fetch;
    await expect(new SmartThings('t', fetcher).locations()).rejects.toThrow(/HTTP 500$/);
  });
});
