import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve, routes, root } from './a11y-preview.mjs';
test('synthetic routes are fixed and the loopback preview serves only the unchanged callback', async () => {
  assert.equal(routes.length, 3);
  assert.equal(new URL(routes[1], 'http://localhost').searchParams.get('code'), 'ZZ-synthetic-code');
  const { server, base } = await serve();
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const source = await readFile(resolve(root, 'docs/oauth-callback.html'), 'utf8');
    for (const route of routes) { const response = await fetch(base + route.slice(1)); assert.equal(response.status, 200); assert.equal(await response.text(), source); }
    assert.equal((await fetch(base + 'config/')).status, 404);
    assert.equal((await fetch(base + 'README.md')).status, 404);
  } finally { server.closeAllConnections(); server.close(); }
});
