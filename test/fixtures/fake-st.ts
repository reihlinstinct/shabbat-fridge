import type { Fetch } from '../../src/smartthings.js';

/** A fake SmartThings API. Records every request so tests can assert the collector only reads. */
export function fakeSt(events: unknown[], log: Array<{ method: string; path: string }> = []): Fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, '');
    log.push({ method: init?.method ?? 'GET', path });
    const ok = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
    if (path === '/locations') return ok({ items: [{ locationId: 'L1' }] });
    if (path === '/locations/L1') return ok({ locationId: 'L1', latitude: 32.1, longitude: 34.8, timeZoneId: 'Asia/Jerusalem', countryCode: 'ISR' });
    if (path === '/devices') return ok({ items: [{ deviceId: 'D1', locationId: 'L1', components: [{ id: 'main', capabilities: [{ id: 'samsungce.sabbathMode' }] }] }] });
    if (path === '/devices/D1/status') return ok({ components: { main: { 'samsungce.sabbathMode': { status: { value: 'off', timestamp: '2026-10-24T16:27:01Z' } } } } });
    if (path === '/rules') return ok({ items: [{ id: 'R1' }] });
    if (path === '/rules/R1') return ok({ id: 'R1', name: 'rule', status: 'Active', dateExecuted: 1, dateUpdated: 2 });
    if (path === '/history/devices') return ok({ items: events });
    return new Response('{}', { status: 404 });
  }) as Fetch;
}
