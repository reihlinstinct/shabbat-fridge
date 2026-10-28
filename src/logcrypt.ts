/**
 * Hybrid public-key encryption for log chunks (see docs/ENCRYPTED-LOGS.md).
 *
 * Chunk layout (every chunk of one bucket size has exactly the same length):
 *   [0]      version byte (1)
 *   [1..32]  ephemeral X25519 public key (fresh for every chunk)
 *   [33..44] random 96-bit AES-GCM nonce (fresh for every chunk)
 *   [45..]   AES-256-GCM ciphertext of the padded payload, then the 16-byte tag
 * Key: HKDF-SHA256(ECDH shared secret, salt = ephemeralPub || recipientPub, info = HKDF_INFO).
 * AAD: version || ephemeralPub || context. The workflow only has the public key and cannot decrypt.
 * Payload (before padding): group(16) | index(2) | total(2) | length(4) | data, zero padded to the bucket size.
 * Errors never include plaintext, keys or ciphertext.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const VERSION = 1;
export const HKDF_INFO = 'shabbat-fridge/logs/v1';
export const DEFAULT_BUCKET = 16 * 1024;
const PUB = 32;
const NONCE = 12;
const TAG = 16;
const HEADER = 16 + 2 + 2 + 4;
const MAX_CHUNKS = 0xffff;
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** The exact size of one encrypted chunk for a bucket size. */
export const chunkSize = (bucket = DEFAULT_BUCKET): number => 1 + PUB + NONCE + bucket + TAG;

const b64 = (v: Buffer): string => v.toString('base64');
function raw32(s: string, what: string): Buffer {
  const b = Buffer.from(s.trim(), 'base64');
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes, base64 encoded`);
  return b;
}
function checkBucket(bucket: number): void {
  if (!Number.isInteger(bucket) || bucket < 1024 || bucket > 1 << 22 || bucket % 1024 !== 0) throw new Error('bucket must be a multiple of 1024 between 1024 and 4194304');
}
function pubKey(pub: Buffer) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
}
function privKey(priv: Buffer) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, priv]), format: 'der', type: 'pkcs8' });
}
function aesKey(shared: Buffer, ephPub: Buffer, recipientPub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), HKDF_INFO, 32));
}
const aad = (ephPub: Buffer, context: string): Buffer => Buffer.concat([Buffer.from([VERSION]), ephPub, Buffer.from(context, 'utf8')]);

/** A new recipient key pair, both base64 raw 32 bytes. Keep the private key off CI, in the owner's vault. */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-PUB);
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { publicKey: b64(Buffer.from(pub)), privateKey: b64(Buffer.from(priv)) };
}

/** Derive the public key from a private key (for checks). */
export function publicKeyOf(privateKey: string): string {
  const pub = createPublicKey(privKey(raw32(privateKey, 'private key'))).export({ format: 'der', type: 'spki' }).subarray(-PUB);
  return b64(Buffer.from(pub));
}

function encryptPayload(payload: Buffer, recipient: Buffer, context: string): Buffer {
  const eph = generateKeyPairSync('x25519');
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-PUB));
  const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey(recipient) }), ephPub, recipient);
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad(ephPub, context));
  const ct = Buffer.concat([c.update(payload), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), ephPub, nonce, ct, c.getAuthTag()]);
}

/**
 * Encrypt data into one or more equal-sized chunks (more than one only when the data does not fit a bucket).
 * `context` binds every chunk to a label (for example the log kind); decrypt must pass the same string.
 */
export function encryptLog(data: Buffer, recipientPublicKey: string, context: string, bucket = DEFAULT_BUCKET): Buffer[] {
  checkBucket(bucket);
  const recipient = raw32(recipientPublicKey, 'public key');
  const room = bucket - HEADER;
  const total = Math.max(1, Math.ceil(data.length / room));
  if (total > MAX_CHUNKS) throw new Error('data too large');
  const group = randomBytes(16);
  const out: Buffer[] = [];
  for (let i = 0; i < total; i++) {
    const part = data.subarray(i * room, (i + 1) * room);
    const payload = Buffer.alloc(bucket);
    group.copy(payload, 0);
    payload.writeUInt16BE(i, 16);
    payload.writeUInt16BE(total, 18);
    payload.writeUInt32BE(part.length, 20);
    part.copy(payload, HEADER);
    out.push(encryptPayload(payload, recipient, context));
  }
  return out;
}

export interface Decrypted {
  group: string;
  index: number;
  total: number;
  data: Buffer;
}

export function decryptChunk(chunk: Buffer, privateKey: string, context: string, bucket = DEFAULT_BUCKET): Decrypted {
  checkBucket(bucket);
  const priv = raw32(privateKey, 'private key');
  if (chunk.length !== chunkSize(bucket)) throw new Error('chunk has the wrong size');
  if (chunk[0] !== VERSION) throw new Error('unsupported chunk version');
  const ephPub = chunk.subarray(1, 1 + PUB);
  const nonce = chunk.subarray(1 + PUB, 1 + PUB + NONCE);
  const body = chunk.subarray(1 + PUB + NONCE, chunk.length - TAG);
  const tag = chunk.subarray(chunk.length - TAG);
  let payload: Buffer;
  try {
    const recipientPub = Buffer.from(publicKeyOf(privateKey), 'base64');
    const key = aesKey(diffieHellman({ privateKey: privKey(priv), publicKey: pubKey(ephPub) }), ephPub, recipientPub);
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad(ephPub, context));
    d.setAuthTag(tag);
    payload = Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error('Cannot decrypt the chunk: wrong key, wrong context or corrupted data');
  }
  const index = payload.readUInt16BE(16);
  const total = payload.readUInt16BE(18);
  const len = payload.readUInt32BE(20);
  if (total < 1 || index >= total || len > bucket - HEADER) throw new Error('chunk header is malformed');
  return { group: payload.subarray(0, 16).toString('hex'), index, total, data: Buffer.from(payload.subarray(HEADER, HEADER + len)) };
}

/** Join decrypted chunks of one group (any order). Throws on malformed parts, mixed groups, duplicates or missing parts. */
export function assemble(parts: Decrypted[]): Buffer {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('no chunks');
  for (const p of parts) {
    const ok = p !== null && typeof p === 'object' && typeof p.group === 'string' && /^[0-9a-f]{32}$/.test(p.group) && Number.isInteger(p.total) && p.total >= 1 && p.total <= MAX_CHUNKS && Number.isInteger(p.index) && p.index >= 0 && p.index < p.total && Buffer.isBuffer(p.data);
    if (!ok) throw new Error('malformed chunk part');
  }
  const { group, total } = parts[0]!;
  const byIndex = new Map<number, Buffer>();
  for (const p of parts) {
    if (p.group !== group || p.total !== total) throw new Error('chunks belong to different groups');
    if (byIndex.has(p.index)) throw new Error('duplicate chunk');
    byIndex.set(p.index, p.data);
  }
  if (byIndex.size !== total) throw new Error('missing chunks');
  const ordered: Buffer[] = [];
  for (let i = 0; i < total; i++) {
    const d = byIndex.get(i);
    if (d === undefined) throw new Error('missing chunks');
    ordered.push(d);
  }
  return Buffer.concat(ordered);
}

/** Gzip, then encrypt. */
export const sealJson = (value: unknown, recipientPublicKey: string, context: string, bucket = DEFAULT_BUCKET): Buffer[] =>
  encryptLog(gzipSync(Buffer.from(JSON.stringify(value), 'utf8')), recipientPublicKey, context, bucket);

export function openJson(chunks: Buffer[], privateKey: string, context: string, bucket = DEFAULT_BUCKET): unknown {
  const data = assemble(chunks.map((c) => decryptChunk(c, privateKey, context, bucket)));
  try {
    return JSON.parse(gunzipSync(data).toString('utf8')) as unknown;
  } catch {
    // The native errors can quote the decrypted text, so they are never passed on.
    throw new Error('The decrypted log is not valid compressed JSON');
  }
}

/** A random opaque chunk file name: 128 random bits, no counter, no timestamp. */
export const chunkFileName = (): string => `${randomBytes(16).toString('hex')}.bin`;
