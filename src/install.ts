import type { Rule } from './rules.js';

/** Only rules whose name matches this are ever created, changed or deleted. */
export const MANAGED_NAME = /^shabbat-fridge holidays \d{4}$/;

export interface ExistingRule extends Rule {
  id: string;
}

export interface Plan {
  create: Rule[];
  update: Array<{ id: string; rule: Rule }>;
  remove: Array<{ id: string; name: string }>;
  unchanged: string[];
  /** Names of existing rules this tool will not touch. */
  untouched: string[];
}

const canonical = (r: Rule): string => JSON.stringify({ name: r.name, actions: r.actions });

/**
 * Compare desired rules with the account's rules. Idempotent: running the plan twice changes nothing the second
 * time. Rules outside MANAGED_NAME are never in create/update/remove. Removal needs `prune`.
 */
export function planInstall(existing: ExistingRule[], desired: Rule[], prune = false): Plan {
  for (const d of desired) {
    if (!MANAGED_NAME.test(d.name)) throw new Error(`refusing to manage a rule named "${d.name}"`);
  }
  const plan: Plan = { create: [], update: [], remove: [], unchanged: [], untouched: [] };
  const managed = existing.filter((r) => MANAGED_NAME.test(r.name));
  plan.untouched = existing.filter((r) => !MANAGED_NAME.test(r.name)).map((r) => r.name);
  for (const d of desired) {
    const matches = managed.filter((r) => r.name === d.name);
    if (matches.length === 0) plan.create.push(d);
    else {
      const [first, ...dupes] = matches;
      if (canonical(first!) === canonical(d)) plan.unchanged.push(d.name);
      else plan.update.push({ id: first!.id, rule: d });
      for (const dup of dupes) plan.remove.push({ id: dup.id, name: dup.name });
    }
  }
  if (prune) {
    const wanted = new Set(desired.map((d) => d.name));
    for (const r of managed) if (!wanted.has(r.name) && !plan.remove.some((x) => x.id === r.id)) plan.remove.push({ id: r.id, name: r.name });
  }
  return plan;
}

export const isEmpty = (p: Plan): boolean => p.create.length + p.update.length + p.remove.length === 0;

/**
 * Which holiday calendar to use. `choice` is the workflow input: "auto" (default) follows the SmartThings
 * location country (Israel = one day of Yom Tov), "israel" forces one day, "diaspora" forces the second
 * day of Yom Tov (Yom Tov Sheni shel Galuyot) for people who keep it outside Israel.
 */
export function resolveIsrael(choice: string | undefined, countryCode: string | null | undefined): boolean {
  const c = (choice ?? 'auto').trim().toLowerCase();
  if (c === 'israel') return true;
  if (c === 'diaspora') return false;
  if (c === 'auto' || c === '') {
    const cc = (countryCode ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(cc)) {
      throw new Error(`Cannot tell the calendar: the SmartThings location country is "${countryCode ?? ''}". Run again with calendar = israel or diaspora.`);
    }
    return cc === 'ISR' || cc === 'IL';
  }
  throw new Error(`calendar must be auto, israel or diaspora (got "${choice}")`);
}
