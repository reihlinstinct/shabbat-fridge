import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkSize, encryptLog } from '../src/logcrypt.js';

describe('config/logs.pub', () => {
  const pub = readFileSync('config/logs.pub', 'utf8');
  it('is one line holding a 32-byte base64 key, and nothing that looks like a private key', () => {
    expect(pub).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(Buffer.from(pub.trim(), 'base64')).toHaveLength(32);
    expect(pub).not.toMatch(/PRIVATE/);
  });
  it('can be used to seal a chunk of the expected size', () => {
    expect(encryptLog(Buffer.from('x'), pub.trim(), 'ctx')[0]).toHaveLength(chunkSize());
  });
});
