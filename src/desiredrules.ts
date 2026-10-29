import { DATED_RULES_BLOCKED, datedRulesBlockedMessage } from './knownissue.js';
import { rulesByYear, weeklyRule, type EveryAction, type Rule, type WeeklyOptions } from './rules.js';

export class DatedRulesBlockedError extends Error {
  constructor() {
    super(datedRulesBlockedMessage());
    this.name = 'DatedRulesBlockedError';
  }
}

export interface DesiredOptions {
  weekly: boolean;
  weeklyOptions: WeeklyOptions;
  /** Dated holiday actions. Ignored (and may be empty) while dated rules are blocked. */
  holidayActions: EveryAction[];
  holidayPrefix?: string;
  /** For tests; defaults to the known-issue switch. */
  blocked?: boolean;
}

/**
 * The rules the tools should create. While dated rules are blocked (issue #63) only the weekly rule is produced, and a
 * request that would produce nothing but dated rules throws DatedRulesBlockedError.
 */
export function desiredRules(o: DesiredOptions): { rules: Rule[]; datedSkipped: boolean } {
  const blocked = o.blocked ?? DATED_RULES_BLOCKED;
  if (blocked && !o.weekly) throw new DatedRulesBlockedError();
  const rules: Rule[] = [];
  if (o.weekly) rules.push(weeklyRule(o.weeklyOptions));
  if (!blocked) rules.push(...rulesByYear(o.holidayPrefix ?? 'shabbat-fridge holidays', o.holidayActions));
  return { rules, datedSkipped: blocked };
}
