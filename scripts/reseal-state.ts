/**
 * Re-seal the OAuth state under a new STATE_KEY (see docs/RUNBOOK-COLLECTOR.md).
 *   STATE_FILE, OLD_STATE_KEY, NEW_STATE_KEY (environment only). Fixed-text output only.
 */
import { reseal } from '../src/reseal.js';

try {
  reseal(process.env.STATE_FILE || '', process.env.OLD_STATE_KEY || '', process.env.NEW_STATE_KEY || '');
  console.log('state re-sealed');
} catch {
  console.log('reseal failed');
  process.exit(1);
}
