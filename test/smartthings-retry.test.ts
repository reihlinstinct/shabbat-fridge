// Retry behaviour of the SmartThings client: transient GET failures (5xx or a
// network error) are retried with a bounded delay budget; 4xx and non-GET
// calls are never retried. Error text stays status-only — no response bodies.
import { describe, expect, it } from 'vitest';
import { SmartThings, type Fetch } from '../src/smartthings.js';

const fakeResponse = (status: number, body = '{"items": []}') =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body }) as Response;

function harness(script: Array<Response | Error>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as Fetch;
  const st = new SmartThings('token', fetcher, 'https://example.test/v1', async (ms) => {
    sleeps.push(ms);
  });
  return { st, calls, sleeps };
}

describe('SmartThings retry on transient failures', () => {
  it('retries a GET on 5xx and returns the later success', async () => {
    const { st, calls, sleeps } = harness([fakeResponse(500), fakeResponse(502), fakeResponse(200)]);
    await expect(st.locations()).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([15_000, 45_000]);
    expect(calls.every((u) => u === 'https://example.test/v1/locations')).toBe(true);
  });

  it('gives up after the bounded attempts and keeps the status-only error', async () => {
    const { st, calls, sleeps } = harness([fakeResponse(500), fakeResponse(500), fakeResponse(503)]);
    await expect(st.locations()).rejects.toThrow('SmartThings GET /locations failed with HTTP 503');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([15_000, 45_000]);
  });

  it('never retries a 4xx', async () => {
    const { st, calls, sleeps } = harness([fakeResponse(403)]);
    await expect(st.locations()).rejects.toThrow('SmartThings GET /locations failed with HTTP 403');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a GET on a network error and returns the later success', async () => {
    const { st, calls } = harness([new TypeError('fetch failed'), fakeResponse(200)]);
    await expect(st.locations()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('rethrows the original network error after the bounded attempts', async () => {
    const boom = new TypeError('fetch failed');
    const { st, calls } = harness([boom, boom, boom]);
    await expect(st.locations()).rejects.toBe(boom);
    expect(calls).toHaveLength(3);
  });

  it('never retries a non-GET call, even on 5xx', async () => {
    const { st, calls, sleeps } = harness([fakeResponse(500)]);
    await expect(st.createApp({})).rejects.toThrow('SmartThings POST /apps failed with HTTP 500');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry a non-JSON 2xx body and never quotes it', async () => {
    const { st, calls } = harness([fakeResponse(200, 'not json at all')]);
    await expect(st.locations()).rejects.toThrow('returned a non-JSON response (HTTP 200)');
    expect(calls).toHaveLength(1);
  });
});
