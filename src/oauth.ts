import type { Fetch } from './smartthings.js';

export const AUTH_URL = 'https://api.smartthings.com/v1/oauth/authorize';
export const TOKEN_URL = 'https://api.smartthings.com/v1/oauth/token';

/** Scopes for the collector (read) and the rule installer (read and write rules). */
export const SCOPES_READ = ['r:locations:*', 'r:devices:*', 'r:rules:*'];
export const SCOPES_INSTALL = [...SCOPES_READ, 'w:rules:*'];

export interface OAuthState {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** ISO time of the last successful exchange or refresh. */
  obtainedAt: string;
  scope?: string;
  /** Sealed too: lets runs reuse a still-valid access token instead of rotating every time. */
  accessToken?: string;
  accessExpiresAt?: string;
  /** Random value bound to the authorization link and checked on code exchange (cleared afterwards). */
  pendingNonce?: string;
  /** Collector cursor (ISO, hour resolution): history events older than this were already sent. Optional: old states have none. */
  eventCursor?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
}

export function authorizeUrl(clientId: string, redirectUri: string, scopes: string[], state: string): string {
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: scopes.join(' '), state });
  return `${AUTH_URL}?${q.toString()}`;
}

async function tokenCall(body: Record<string, string>, clientId: string, clientSecret: string, fetcher: Fetch): Promise<TokenResponse> {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body: ignored, never printed */
  }
  const obj = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    // Only the status and the standard OAuth error code. Bodies and descriptions can echo credentials.
    const code = typeof obj.error === 'string' && /^[a-z_]{1,40}$/.test(obj.error) ? obj.error : 'unknown';
    throw new Error(`SmartThings token endpoint failed with HTTP ${res.status} (${code})`);
  }
  if (!isToken(obj.access_token) || !isToken(obj.refresh_token)) throw new Error('SmartThings token response has a missing or malformed access_token or refresh_token');
  if (obj.expires_in !== undefined && !(typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in) && obj.expires_in > 0)) {
    throw new Error('SmartThings token response has an invalid expires_in');
  }
  if (obj.scope !== undefined && typeof obj.scope !== 'string') throw new Error('SmartThings token response has an invalid scope');
  return { access_token: obj.access_token, refresh_token: obj.refresh_token, expires_in: obj.expires_in as number | undefined, scope: obj.scope as string | undefined };
}

/** A token is a non-empty string of printable ASCII without whitespace or control characters (it goes into GITHUB_ENV). */
export const isToken = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && /^[\x21-\x7e]+$/.test(v);

export function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string, fetcher: Fetch = fetch): Promise<TokenResponse> {
  return tokenCall({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri }, clientId, clientSecret, fetcher);
}

/**
 * Refresh tokens are single-use: the response carries a NEW refresh token that must be stored. Returns the new state
 * only when the whole exchange succeeded; on any failure it throws and the caller keeps the old state untouched.
 */
export async function refreshState(state: OAuthState, fetcher: Fetch = fetch, now = new Date()): Promise<{ state: OAuthState; accessToken: string }> {
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: state.refreshToken, client_id: state.clientId }, state.clientId, state.clientSecret, fetcher);
  if (t.refresh_token === state.refreshToken) throw new Error('Refresh did not return a new refresh token; refusing to continue');
  return {
    accessToken: t.access_token,
    state: {
      ...state,
      refreshToken: t.refresh_token,
      obtainedAt: now.toISOString(),
      scope: t.scope ?? state.scope,
      accessToken: t.access_token,
      accessExpiresAt: new Date(now.getTime() + (t.expires_in ?? 86000) * 1000).toISOString(),
    },
  };
}
