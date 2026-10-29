/**
 * Known issue: dated holiday rules appear to fire every day on SmartThings' side (issue #63).
 * Until SmartThings answers, the tools do not create dated rules. The weekly Shabbat rule (Friday ON, Saturday OFF)
 * is not dated and keeps working.
 */
export const KNOWN_ISSUE_URL = 'https://github.com/reihlinstinct/shabbat-fridge/issues/63';
export const SAMSUNG_TICKET = '1629394';
/** Set to false only after SmartThings has answered and the behaviour was verified. Typed as boolean so code after a guard is still type checked. */
export const DATED_RULES_BLOCKED = true as boolean;
/** Exit code of the scripts that refuse to run. */
export const KNOWN_ISSUE_EXIT = 3;

export function datedRulesBlockedMessage(): string {
  return [
    'Stopped before doing anything: dated holiday rules are blocked by a known SmartThings issue.',
    'They appear to fire every day instead of only on their date, which puts the fridge in and out of Sabbath mode on ordinary weekdays.',
    `Details: ${KNOWN_ISSUE_URL} (SmartThings ticket ${SAMSUNG_TICKET}).`,
    'Nothing was created, changed or deleted. The weekly Shabbat rule still works: set WEEKLY_RULES=true (workflow input weekly_rules).',
    'If you already installed "shabbat-fridge holidays" rules, delete them in SmartThings for now.',
  ].join('\n');
}

/** One line for runs that continue with the weekly rule only. */
export const datedRulesSkippedNotice = (): string => `Dated holiday rules are skipped: known SmartThings issue ${KNOWN_ISSUE_URL} (ticket ${SAMSUNG_TICKET}). Only the weekly Shabbat rule is handled.`;
