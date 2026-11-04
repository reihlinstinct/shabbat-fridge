import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Offline source/doc consistency, not a test that calls the account adapter.
describe('documented installer side effects', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const installer = readFileSync(new URL('../scripts/install.ts', import.meta.url), 'utf8');
  it('does not claim the whole project is read-only or design-only', () => {
    expect(readme).not.toContain('nothing here writes to SmartThings yet');
    expect(readme).not.toContain('**Status: design phase.**');
    expect(readme).toContain('**Status: implemented planner and installer.**');
  });
  it('states dry-run and non-dry create/update/delete boundaries', () => {
    expect(readme).toContain('dry run makes no writes');
    expect(readme).toMatch(/non-dry installer run can create, update and delete managed SmartThings rules/);
    expect(installer).toContain("if (dry) say('Dry run: nothing was written.");
    for (const method of ['createRule', 'updateRule', 'deleteRule']) expect(installer).toContain(`await st.${method}(`);
    expect(readme).toContain('docs/INSTALL-WORKFLOW.md');
  });
  it('retains paused dated rules and opt-in weekly rules', () => {
    expect(readme).toContain('Dated holiday rules remain paused');
    expect(readme).toContain('weekly rules are opt-in');
    expect(readme).toContain('issue #63');
  });
});
