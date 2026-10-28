import { describe, expect, it } from 'vitest';
import { DEFAULT_BUCKET, assemble, chunkFileName, chunkSize, decryptChunk, encryptLog, generateKeyPair, openJson, publicKeyOf, sealJson } from '../src/logcrypt.js';

const CTX = 'snapshot';
const kp = generateKeyPair();
const enc = (d: Buffer | string, ctx = CTX, bucket = DEFAULT_BUCKET) => encryptLog(Buffer.from(d), kp.publicKey, ctx, bucket);

describe('log crypto', () => {
  it('key pairs are 32-byte base64 and the private key derives the public key', () => {
    expect(Buffer.from(kp.publicKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(kp.privateKey, 'base64')).toHaveLength(32);
    expect(publicKeyOf(kp.privateKey)).toBe(kp.publicKey);
    expect(generateKeyPair().publicKey).not.toBe(kp.publicKey);
  });
  it('round trips and returns exactly the data, including empty and binary', () => {
    for (const d of [Buffer.alloc(0), Buffer.from('hello door'), Buffer.from([0, 1, 2, 255, 0, 0])]) {
      const [c] = enc(d);
      expect(assemble([decryptChunk(c!, kp.privateKey, CTX)]).equals(d)).toBe(true);
    }
  });
  it('pins the layout: version byte 1, ephemeral key, 96-bit nonce, tag, fixed size', () => {
    const [c] = enc('x');
    expect(c![0]).toBe(1);
    expect(c!.length).toBe(1 + 32 + 12 + DEFAULT_BUCKET + 16);
    expect(chunkSize()).toBe(c!.length);
  });
  it('every chunk has the same length whatever the content size (padding)', () => {
    for (const d of ['', 'a', 'a'.repeat(5000), 'b'.repeat(16000)]) for (const c of enc(d)) expect(c.length).toBe(chunkSize());
  });
  it('spills into more equal chunks and reassembles in any order; the spill is the only size signal', () => {
    const big = Buffer.from('z'.repeat(40000));
    const chunks = enc(big);
    expect(chunks.length).toBe(3);
    const parts = chunks.map((c) => decryptChunk(c, kp.privateKey, CTX)).reverse();
    expect(assemble(parts).equals(big)).toBe(true);
  });
  it('assemble rejects missing, duplicate and mixed chunks', () => {
    const a = enc('z'.repeat(40000)).map((c) => decryptChunk(c, kp.privateKey, CTX));
    const b = enc('y'.repeat(40000)).map((c) => decryptChunk(c, kp.privateKey, CTX));
    expect(() => assemble(a.slice(0, 2))).toThrow(/missing/);
    expect(() => assemble([a[0]!, a[0]!, a[2]!])).toThrow(/duplicate/);
    expect(() => assemble([a[0]!, b[1]!, a[2]!])).toThrow(/different groups/);
    expect(() => assemble([])).toThrow();
  });
  it('uses a fresh ephemeral key and nonce for every chunk, so identical input gives different ciphertext', () => {
    const cs = Array.from({ length: 20 }, () => enc('same')[0]!);
    expect(new Set(cs.map((c) => c.subarray(1, 33).toString('hex'))).size).toBe(20);
    expect(new Set(cs.map((c) => c.subarray(33, 45).toString('hex'))).size).toBe(20);
    expect(new Set(cs.map((c) => c.toString('hex'))).size).toBe(20);
  });
  it('contains no plaintext canary', () => {
    const canary = 'CANARY-door-48612326-a461-d61d';
    const chunks = [...enc(canary), ...sealJson({ id: canary }, kp.publicKey, CTX)];
    for (const c of chunks) expect(c.includes(Buffer.from(canary))).toBe(false);
  });
  it('rejects any flipped byte in the version, key, nonce, body or tag region', () => {
    const [c] = enc('secret');
    for (const pos of [0, 1, 20, 33, 40, 45, 100, 8000, c!.length - 17, c!.length - 1]) {
      const t = Buffer.from(c!);
      t[pos] = t[pos]! ^ 1;
      expect(() => decryptChunk(t, kp.privateKey, CTX)).toThrow();
    }
  });
  it('rejects the wrong private key, the wrong context and the wrong size', () => {
    const [c] = enc('secret');
    expect(() => decryptChunk(c!, generateKeyPair().privateKey, CTX)).toThrow(/Cannot decrypt/);
    expect(() => decryptChunk(c!, kp.privateKey, 'other')).toThrow(/Cannot decrypt/);
    expect(() => decryptChunk(c!.subarray(0, c!.length - 1), kp.privateKey, CTX)).toThrow(/size/);
    expect(() => decryptChunk(c!, kp.privateKey, CTX, 8192)).toThrow(/size/);
  });
  it('rejects an unknown version byte', () => {
    const [c] = enc('secret');
    const t = Buffer.from(c!);
    t[0] = 2;
    expect(() => decryptChunk(t, kp.privateKey, CTX)).toThrow(/version/);
  });
  it('validates keys and bucket sizes', () => {
    expect(() => encryptLog(Buffer.from('x'), 'AAAA', CTX)).toThrow(/public key/);
    expect(() => decryptChunk(Buffer.alloc(chunkSize()), 'AAAA', CTX)).toThrow(/private key/);
    for (const b of [0, 1000, 1500, 5 * 1024 * 1024, 1.5]) expect(() => enc('x', CTX, b)).toThrow(/bucket/);
  });
  it('errors never contain the plaintext or the keys', () => {
    const canary = 'CANARY-plain';
    const [c] = enc(canary);
    for (const f of [() => decryptChunk(c!, generateKeyPair().privateKey, CTX), () => decryptChunk(c!, kp.privateKey, 'x')]) {
      try { f(); } catch (e) {
        const m = String((e as Error).message);
        expect(m).not.toContain(canary);
        expect(m).not.toContain(kp.privateKey);
        expect(m).not.toContain(kp.publicKey);
      }
    }
  });
  it('sealJson and openJson round trip, with a spill', () => {
    const v = { a: 1, rows: Array.from({ length: 4000 }, (_, i) => ({ i, r: Math.random().toString(36) })) };
    const chunks = sealJson(v, kp.publicKey, CTX, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(openJson(chunks, kp.privateKey, CTX, 4096)).toEqual(v);
  });
  it('chunk file names are 128 random bits as hex with no structure', () => {
    const names = Array.from({ length: 50 }, chunkFileName);
    expect(new Set(names).size).toBe(50);
    for (const n of names) expect(n).toMatch(/^[0-9a-f]{32}\.bin$/);
  });
});

describe('safe failures and malformed parts', () => {
  const canary = 'CANARY-private-door-timing';
  const whole = (e: unknown): string => JSON.stringify(e, Object.getOwnPropertyNames(e as object)) + String(e);
  it('openJson throws a fixed error that does not quote the plaintext (not gzip, gzip of non-JSON)', async () => {
    const { gzipSync } = await import('node:zlib');
    for (const data of [Buffer.from(canary), gzipSync(Buffer.from(canary)), gzipSync(Buffer.from('{"a":' + canary))]) {
      const chunks = encryptLog(data, kp.publicKey, CTX);
      let err: unknown;
      try { openJson(chunks, kp.privateKey, CTX); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('The decrypted log is not valid compressed JSON');
      expect(whole(err)).not.toContain(canary);
      expect(whole(err)).not.toContain('CANARY');
    }
  });
  const good = { group: 'a'.repeat(32), index: 0, total: 1, data: Buffer.from('x') };
  it('assemble accepts a well-formed single part', () => {
    expect(assemble([good]).toString()).toBe('x');
  });
  it('assemble rejects malformed parts', () => {
    const bad: unknown[] = [
      { ...good, group: 'zz' },
      { ...good, group: 'A'.repeat(32) },
      { ...good, total: 0 },
      { ...good, total: 65536 },
      { ...good, total: 1.5 },
      { ...good, index: -1 },
      { ...good, index: 1 },
      { ...good, index: 0.5 },
      { ...good, index: Number.NaN },
      { ...good, data: 'x' },
      { ...good, total: Number.POSITIVE_INFINITY },
      null,
      'x',
    ];
    for (const b of bad) expect(() => assemble([b as never])).toThrow(/malformed/);
    expect(() => assemble([good, { ...good, group: 'b'.repeat(32) }])).toThrow(/different groups/);
    expect(() => assemble({} as never)).toThrow();
  });
  it('assemble needs every index before joining, even when the count matches', () => {
    const g = 'c'.repeat(32);
    expect(() => assemble([{ group: g, index: 0, total: 2, data: Buffer.from('a') }, { group: g, index: 0, total: 2, data: Buffer.from('b') }])).toThrow(/duplicate/);
    expect(assemble([{ group: g, index: 1, total: 2, data: Buffer.from('b') }, { group: g, index: 0, total: 2, data: Buffer.from('a') }]).toString()).toBe('ab');
  });
});
