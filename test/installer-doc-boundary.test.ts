import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { planInstall, type ExistingRule } from '../src/install.js';

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
    const ast = ts.createSourceFile('install.ts', installer, ts.ScriptTarget.Latest, true);
    const dryBranch = ast.statements.find((node) => ts.isIfStatement(node) && node.expression.getText(ast) === 'dry');
    expect(dryBranch && ts.isIfStatement(dryBranch)).toBe(true);
    const noOp = (dryBranch as ts.IfStatement).elseStatement;
    expect(noOp && ts.isIfStatement(noOp)).toBe(true);
    const apply = (noOp as ts.IfStatement).elseStatement;
    expect(apply && ts.isBlock(apply)).toBe(true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ['st.createRule', 'st.updateRule', 'st.deleteRule'].includes(node.expression.getText(ast))) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(calls.map((node) => node.expression.getText(ast)).sort()).toEqual(['st.createRule', 'st.deleteRule', 'st.updateRule']);
    for (const call of calls) {
      expect(call.getStart(ast)).toBeGreaterThan(apply!.getStart(ast));
      expect(call.getEnd()).toBeLessThan(apply!.getEnd());
    }
    expect(readme).toContain('docs/INSTALL-WORKFLOW.md');
  });
  it('qualifies paused-rule preservation with the actual prune behavior', () => {
    const paused: ExistingRule = { id: 'synthetic-year', name: 'shabbat-fridge holidays 2028', actions: [] };
    const weekly = { name: 'shabbat-fridge weekly', actions: [] };
    expect(planInstall([paused], [weekly], false).remove).toEqual([]);
    expect(planInstall([paused], [weekly], true).remove).toEqual([{ id: paused.id, name: paused.name }]);
    const duplicateWeekly = [{ ...weekly, id: 'synthetic-one' }, { ...weekly, id: 'synthetic-two' }];
    expect(planInstall(duplicateWeekly, [weekly], false).remove).toEqual([{ id: 'synthetic-two', name: weekly.name }]);
    expect(readme).toContain('default `PRUNE=false`');
    expect(readme).toContain('non-dry run with `PRUNE=true` can remove them');
    expect(readme).toContain('Duplicate managed rules can also be removed without PRUNE');
  });
  it('retains paused dated rules and opt-in weekly rules', () => {
    expect(readme).toContain('Dated holiday rules remain paused');
    expect(readme).toContain('weekly rules are opt-in');
    expect(readme).toContain('issue #63');
  });
});
