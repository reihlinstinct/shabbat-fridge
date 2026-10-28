import type { Block } from './blocks.js';

/** One timed command in SmartThings Rules API JSON (`every` + `specific`). */
export interface EveryAction {
  every: {
    specific: {
      year: number;
      month: number;
      day: number;
      reference: 'Sunset';
      offset: { value: { integer: number }; unit: 'Minute' };
    };
    actions: Array<{
      command: { devices: string[]; commands: Array<{ component: string; capability: string; command: 'on' | 'off' }> };
    }>;
  };
}

export interface Rule {
  name: string;
  actions: EveryAction[];
}

export interface RuleOptions {
  deviceId: string;
  entryMinutesBeforeSunset?: number;
  exitMinutesAfterSunset?: number;
}

const CAPABILITY = 'samsungce.sabbathMode';

function at(day: Date, offsetMinutes: number, command: 'on' | 'off', deviceId: string): EveryAction {
  return {
    every: {
      specific: {
        year: day.getFullYear(),
        month: day.getMonth() + 1,
        day: day.getDate(),
        reference: 'Sunset',
        offset: { value: { integer: offsetMinutes }, unit: 'Minute' },
      },
      actions: [{ command: { devices: [deviceId], commands: [{ component: 'main', capability: CAPABILITY, command }] } }],
    },
  };
}

const parseDay = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

/**
 * Turn blocks into dated Sunset-relative actions: ON on the eve of the first day (sunset - entry),
 * OFF on the last day (sunset + exit). The Rules engine resolves "Sunset" for the SmartThings Location itself,
 * so the generated rules carry no coordinates.
 */
export function blocksToActions(blocks: Block[], opts: RuleOptions): EveryAction[] {
  const entry = opts.entryMinutesBeforeSunset ?? 10;
  const exit = opts.exitMinutesAfterSunset ?? 40;
  const out: EveryAction[] = [];
  for (const b of blocks) {
    const first = parseDay(b.days[0]!);
    const eve = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1);
    out.push(at(eve, -entry, 'on', opts.deviceId));
    out.push(at(parseDay(b.days[b.days.length - 1]!), exit, 'off', opts.deviceId));
  }
  return out;
}

export function buildRule(name: string, blocks: Block[], opts: RuleOptions): Rule {
  return { name, actions: blocksToActions(blocks, opts) };
}

/** A comparable, location-independent key for a timed on/off action. */
export interface Entry {
  date: string;
  offset: number;
  command: 'on' | 'off';
}

const key = (e: Entry): string => `${e.date} ${e.command} ${e.offset >= 0 ? '+' : ''}${e.offset}`;

export function entriesOf(rules: Rule[], deviceId: string): { dated: Entry[]; weekly: string[]; skipped: number } {
  const dated: Entry[] = [];
  const weekly: string[] = [];
  let skipped = 0;
  for (const rule of rules) {
    for (const a of rule.actions) {
      const sp = a.every.specific as unknown as {
        year?: number;
        month?: number;
        day?: number;
        daysOfWeek?: string[];
        reference: string;
        offset?: { value: { integer: number } };
      };
      if (sp.reference !== 'Sunset') {
        skipped++;
        continue;
      }
      for (const act of a.every.actions) {
        const cmd = act.command.commands.find((c) => c.capability === CAPABILITY);
        if (!cmd || !act.command.devices.includes(deviceId)) {
          skipped++;
          continue;
        }
        const offset = sp.offset?.value.integer ?? 0;
        if (sp.year && sp.month && sp.day) {
          const date = `${sp.year}-${String(sp.month).padStart(2, '0')}-${String(sp.day).padStart(2, '0')}`;
          dated.push({ date, offset, command: cmd.command });
        } else if (sp.daysOfWeek) {
          weekly.push(`${sp.daysOfWeek.join(',')} ${cmd.command} ${offset >= 0 ? '+' : ''}${offset}`);
        }
      }
    }
  }
  return { dated, weekly, skipped };
}

export interface Diff {
  /** Desired entries missing from the existing rules. */
  missing: string[];
  /** Existing dated entries that are not in the desired set. */
  extra: string[];
  /** Existing weekly rules. They fire regardless of holidays, so a weekly OFF can end a holiday early. */
  weeklyRules: string[];
  /** Rules or actions that do not use a Sunset reference or this device and were ignored. */
  skipped: number;
}

/** Dry run: compare desired actions against the existing rules. Pure, sends nothing. */
export function diffRules(existing: Rule[], desired: EveryAction[], deviceId: string): Diff {
  const want = entriesOf([{ name: 'desired', actions: desired }], deviceId).dated.map(key);
  const have = entriesOf(existing, deviceId);
  const haveKeys = have.dated.map(key);
  return {
    missing: want.filter((k) => !haveKeys.includes(k)),
    extra: haveKeys.filter((k) => !want.includes(k)),
    weeklyRules: have.weekly,
    skipped: have.skipped,
  };
}
