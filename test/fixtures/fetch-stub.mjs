// Preloaded into a child process (node --import) so script tests never touch the network.
const events = JSON.parse(process.env.STUB_EVENTS || '[]');
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const p = u.pathname.replace(/^\/v1/, '');
  if ((init?.method ?? 'GET') !== 'GET') return new Response('{}', { status: 405 });
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (p === '/locations') return ok({ items: [{ locationId: 'L1' }] });
  if (p === '/locations/L1') return ok({ locationId: 'L1', latitude: 32.1, longitude: 34.8, timeZoneId: 'Asia/Jerusalem', countryCode: 'ISR' });
  if (p === '/devices') return ok({ items: [{ deviceId: 'D1', locationId: 'L1', components: [{ id: 'main', capabilities: [{ id: 'samsungce.sabbathMode' }] }] }] });
  if (p === '/devices/D1/status') return ok({ components: { main: { 'samsungce.sabbathMode': { status: { value: 'off', timestamp: '2026-10-24T16:27:01Z' } } } } });
  if (p === '/rules') return ok({ items: [{ id: 'R1' }] });
  if (p === '/rules/R1') return ok({ id: 'R1', name: 'rule', status: 'Active', dateExecuted: 1, dateUpdated: 2 });
  if (p === '/history/devices') return ok({ items: events });
  return new Response('{}', { status: 404 });
};
