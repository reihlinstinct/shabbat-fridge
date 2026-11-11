// Synthetic code/error/missing states only. Never use real authorization codes.
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, routes } from './a11y-preview.mjs';
const tools = process.env.A11Y_TOOLS;
if (!tools || !isAbsolute(tools)) throw new Error('tool path');
const { scan } = await import(pathToFileURL(resolve(tools, 'scan.mjs')));
const preview = await serve();
try {
  const result = await scan(preview.base, { version: 1, paths: routes }, { inspect: async (page, report) => {
    const url = new URL(page.url());
    if (url.search || url.hash || url.pathname !== '/oauth-callback.html') throw new Error('query not cleared');
    const code = page.locator('#code');
    if (report.page === 2) {
      if (!await code.isVisible() || await code.textContent() !== 'ZZ-synthetic-code~ZZ-synthetic-state') throw new Error('synthetic code state');
      if (process.env.A11Y_SCREENSHOT && report.engine === 'chromium' && report.width === 390) await page.screenshot({ path: process.env.A11Y_SCREENSHOT });
    } else if (await code.isVisible()) throw new Error('unexpected code state');
    const message = await page.locator('#msg').textContent();
    if (report.page === 1 && !message.startsWith('No code in the address.')) throw new Error('missing state');
    if (report.page === 3 && !message.startsWith('Authorization was not granted')) throw new Error('error state');
  } });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'pass' ? 0 : 1;
} catch {
  console.log('{"schema_version":1,"status":"error","scope":"automated-only"}'); process.exitCode = 2;
} finally { preview.server.closeAllConnections(); preview.server.close(); }
