import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { OAuthState } from './oauth.js';

const AAD = Buffer.from('shabbat-fridge-oauth-state-v1');

export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

/** A fresh random 256-bit key, base64. Keep it only in a repo secret of the PRIVATE repository. */
export const newKey = (): string => randomBytes(32).toString('base64');

function keyBytes(key: string): Buffer {
  const b = Buffer.from(key.trim(), 'base64');
  if (b.length !== 32) throw new Error('STATE_KEY must be 32 bytes, base64 encoded');
  return b;
}

export function seal(state: OAuthState, key: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(state), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function open(sealed: Sealed, key: string): OAuthState {
  if (sealed.v !== 1) throw new Error('unsupported state version');
  const d = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(sealed.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  let plain: string;
  try {
    plain = Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new Error('Cannot decrypt the OAuth state: wrong STATE_KEY or corrupted file');
  }
  const s = JSON.parse(plain) as OAuthState;
  if (!s.clientId || !s.clientSecret || !s.refreshToken) throw new Error('OAuth state is incomplete');
  return s;
}
