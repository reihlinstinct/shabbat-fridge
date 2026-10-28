import type { Rule } from './rules.js';

export interface StRuleSummary {
  id: string;
  name: string;
}
export interface StRule extends Rule {
  id: string;
}
export interface StLocation {
  locationId: string;
  name?: string;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  timeZoneId?: string | null;
}
export interface StDevice {
  deviceId: string;
  label?: string;
  name?: string;
  locationId?: string;
  components?: Array<{ id: string; capabilities: Array<{ id: string }> }>;
}

export interface HistoryEvent {
  time: string;
  epoch?: number;
  hash?: number;
  component?: string;
  componentId?: string;
  capability?: string;
  attribute?: string;
  value?: unknown;
  [k: string]: unknown;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Minimal SmartThings REST client. The token is only ever placed in the Authorization header. */
export class SmartThings {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
    private readonly base = 'https://api.smartthings.com/v1',
  ) {
    if (!token) throw new Error('SmartThings token is empty');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Status and method/path only. The response body can echo request data, so it is not printed.
      throw new Error(`SmartThings ${method} ${path.split('?')[0]} failed with HTTP ${res.status}`);
    }
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      // Never let the parser quote the body: it can hold a token or other private data.
      throw new Error(`SmartThings ${method} ${path.split('?')[0]} returned a non-JSON response (HTTP ${res.status})`);
    }
  }

  async locations(): Promise<StLocation[]> {
    return (await this.call<{ items: StLocation[] }>('GET', '/locations')).items;
  }
  location(id: string): Promise<StLocation> {
    return this.call('GET', `/locations/${id}`);
  }
  async devices(): Promise<StDevice[]> {
    return (await this.call<{ items: StDevice[] }>('GET', '/devices')).items;
  }
  deviceStatus(deviceId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/devices/${deviceId}/status`);
  }
  /** Device event history (undocumented in the official reference, about 7 days). Pages until empty or maxPages. */
  async deviceHistory(locationId: string, deviceId: string, maxPages = 40): Promise<HistoryEvent[]> {
    const out: HistoryEvent[] = [];
    let path = `/history/devices?locationId=${locationId}&deviceId=${deviceId}&limit=300`;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.call<{ items?: HistoryEvent[]; _links?: { next?: { href?: string } } }>('GET', path);
      out.push(...(page.items ?? []));
      const next = page._links?.next?.href;
      if (!page.items?.length || !next) break;
      // next is an absolute URL on the same host; keep only the path and query
      const u = new URL(next);
      path = `${u.pathname.replace(/^\/v1/, '')}${u.search}`;
    }
    return out;
  }
  /** Create an OAuth-In (API_ONLY) app. Needs a token with app-management scopes. */
  createApp(body: unknown): Promise<Record<string, unknown>> {
    return this.call('POST', '/apps', body);
  }
  setAppOauth(appId: string, body: unknown): Promise<Record<string, unknown>> {
    return this.call('PUT', `/apps/${appId}/oauth`, body);
  }
  getAppOauth(appId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/apps/${appId}/oauth`);
  }
  async rules(locationId: string): Promise<StRuleSummary[]> {
    return (await this.call<{ items: StRuleSummary[] }>('GET', `/rules?locationId=${locationId}`)).items;
  }
  rule(locationId: string, id: string): Promise<StRule> {
    return this.call('GET', `/rules/${id}?locationId=${locationId}`);
  }
  createRule(locationId: string, rule: Rule): Promise<StRule> {
    return this.call('POST', `/rules?locationId=${locationId}`, rule);
  }
  updateRule(locationId: string, id: string, rule: Rule): Promise<StRule> {
    return this.call('PUT', `/rules/${id}?locationId=${locationId}`, rule);
  }
  async deleteRule(locationId: string, id: string): Promise<void> {
    await this.call('DELETE', `/rules/${id}?locationId=${locationId}`);
  }
}

export const SABBATH_CAPABILITY = 'samsungce.sabbathMode';

export function sabbathDevices(devices: StDevice[], locationId?: string): StDevice[] {
  return devices.filter(
    (d) =>
      (!locationId || d.locationId === locationId) &&
      (d.components ?? []).some((c) => c.capabilities.some((cap) => cap.id === SABBATH_CAPABILITY)),
  );
}
