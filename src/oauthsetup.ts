import type { SmartThings } from './smartthings.js';

export interface CreatedApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/**
 * Create the OAuth-In app and set its OAuth settings, then read the scopes back. A reported SmartThings bug
 * (PUT /apps/{id}/oauth turning "*" into "$") makes the check below necessary: any "$" in the stored scopes fails.
 */
export async function createOauthApp(st: SmartThings, name: string, redirectUri: string, scopes: string[]): Promise<CreatedApp> {
  const created = (await st.createApp({
    appName: name,
    displayName: name,
    description: 'Shabbat fridge rules and read-only snapshots (personal use)',
    singleInstance: true,
    appType: 'API_ONLY',
    classifications: ['CONNECTED_SERVICE'],
    apiOnly: {},
  })) as { app?: { appId?: string }; appId?: string; oauthClientId?: string; oauthClientSecret?: string };
  const appId = created.app?.appId ?? created.appId;
  if (!appId) throw new Error('App creation returned no appId');
  const oauth = (await st.setAppOauth(appId, { clientName: name, scope: scopes, redirectUris: [redirectUri] })) as { oauthClientId?: string; oauthClientSecret?: string };
  const clientId = oauth.oauthClientId ?? created.oauthClientId;
  const clientSecret = oauth.oauthClientSecret ?? created.oauthClientSecret;
  if (!clientId || !clientSecret) throw new Error('App creation returned no client id or secret');
  const stored = (await st.getAppOauth(appId)) as { scope?: string[]; redirectUris?: string[] };
  const got = stored.scope ?? [];
  if (got.some((x) => x.includes('$')) || [...scopes].sort().join() !== [...new Set(got)].sort().join()) {
    throw new Error(`Stored scopes differ from the request (${got.join(' ')}). Delete app ${appId} and create it with the SmartThings CLI instead.`);
  }
  if (!(stored.redirectUris ?? []).includes(redirectUri)) throw new Error('Stored redirect URI differs from the request');
  return { appId, clientId, clientSecret, scopes: got };
}

/** What create-app prints. Fixed text plus the state file path: never the app id, client id or secret. */
export const createAppNotice = (file: string): string => `App created. Sealed state written to ${file}. Next: authorize-url.`;
