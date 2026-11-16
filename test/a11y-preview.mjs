// No account or network operations: serve only the static callback.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const routes = ['/oauth-callback.html', '/oauth-callback.html?code=ZZ-synthetic-code&state=ZZ-synthetic-state', '/oauth-callback.html?error=access_denied'];
export async function serve(port = 0) {
  const body = await readFile(resolve(root, 'docs/oauth-callback.html'));
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/oauth-callback.html') { res.writeHead(404); res.end('Synthetic preview unavailable'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}
if (process.argv[2] === 'preview') {
  await serve(8765);
  await writeFile(resolve(root, '.a11y-routes.json'), JSON.stringify({ version: 1, paths: routes }));
  console.log('Synthetic accessibility preview ready');
}
