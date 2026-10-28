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
  let json: Partial<TokenResponse> & { error?: string } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    /* non-JSON body: ignored, never printed */
  }
  if (!res.ok) {
    // Only the status and the standard OAuth error code. Bodies and descriptions can echo credentials.
    const code = typeof json.error === 'string' && /^[a-z_]{1,40}$/.test(json.error) ? json.error : 'unknown';
    throw new Error(`SmartThings token endpoint failed with HTTP ${res.status} (${code})`);
  }
  if (!json.access_token || !json.refresh_token) throw new Error('SmartThings token response is missing access_token or refresh_token');
  return json as TokenResponse;
}

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
