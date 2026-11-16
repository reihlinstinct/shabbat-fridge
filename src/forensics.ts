import type { Block } from './blocks.js';

/** One read-only snapshot of the fridge's Sabbath mode. Only this part is analysed. */
export interface Snapshot {
  takenAt: string;
  sabbath: { value: 'on' | 'off'; timestamp: string } | null;
}

export interface Transition {
  at: Date;
  value: 'on' | 'off';
}

/**
 * The status of samsungce.sabbathMode carries the time of its last change. Collecting it periodically therefore
 * reconstructs the change log, except for changes that were overwritten between two snapshots (see `maxGapMinutes`).
 */
export function transitionsFrom(snaps: Snapshot[]): Transition[] {
  const seen = new Map<string, Transition>();
  for (const s of snaps) {
    if (!s.sabbath) continue;
    const t = { at: new Date(s.sabbath.timestamp), value: s.sabbath.value };
    seen.set(`${t.at.toISOString()} ${t.value}`, t);
  }
  return [...seen.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function maxGapMinutes(snaps: Snapshot[]): number {
  const t = snaps.map((s) => new Date(s.takenAt).getTime()).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < t.length; i++) gap = Math.max(gap, (t[i]! - t[i - 1]!) / 60000);
  return Math.round(gap);
}

export type FindingKind = 'ok' | 'missed-reon' | 'missed-on' | 'early-exit' | 'late-exit' | 'unexplained-on' | 'not-covered';
export interface Finding {
  kind: FindingKind;
  /** Block days, e.g. "2026-10-23..2026-10-24" (public calendar information only). */
  block: string;
  /** Minutes relative to the expected time (negative = earlier). */
  minutes?: number;
  detail: string;
}

const mins = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / 60000);

/** An expected OFF window inside a block: the weekly Saturday OFF fires, then the holiday re-ON follows. */
export interface Gap {
  from: Date;
  to: Date;
}

/**
 * Companion design: on every Saturday that is not the last day of the block, the weekly rule turns the mode OFF at
 * sunset + exit and the holiday rule turns it ON again at sunset + reenter. `sunsetOf` gives local sunset for a day.
 */
export function companionGaps(b: Block, sunsetOf: (day: Date) => Date, exit = 90, reenter = 100): Gap[] {
  const out: Gap[] = [];
  b.days.slice(0, -1).forEach((day) => {
    const d = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
    if (d.getDay() !== 6) return;
    const ss = sunsetOf(d).getTime();
    out.push({ from: new Date(ss + exit * 60000), to: new Date(ss + reenter * 60000) });
  });
  return out;
}

/**
 * Compare observed transitions with the blocks the rules are meant to produce (block.start = ON, block.end = OFF).
 * `tolMinutes` is the slack around scheduled times. A block is judged only when snapshots cover it
 * (first snapshot at or before start, last snapshot at or after end + tol).
 */
export function analyze(snaps: Snapshot[], blocks: Block[], tolMinutes = 15, gapsOf: (b: Block) => Gap[] = () => []): Finding[] {
  const out: Finding[] = [];
  if (snaps.length === 0) return out;
  const trans = transitionsFrom(snaps);
  const takes = snaps.map((s) => new Date(s.takenAt).getTime());
  const first = Math.min(...takes);
  const last = Math.max(...takes);
  const tol = tolMinutes * 60000;
  const stateAt = (t: Date): 'on' | 'off' | null => {
    let v: 'on' | 'off' | null = null;
    for (const tr of trans) if (tr.at.getTime() <= t.getTime()) v = tr.value;
    return v;
  };
  for (const b of blocks) {
    const label = `${b.days[0]}..${b.days[b.days.length - 1]}`;
    if (first > b.start.getTime() || last < b.end.getTime() + tol) {
      if (b.end.getTime() >= first && b.start.getTime() <= last) out.push({ kind: 'not-covered', block: label, detail: 'snapshots do not cover the whole block' });
      continue;
    }
    let bad = false;
    const gaps = gapsOf(b);
    const inGap = (t: Date): boolean => gaps.some((g) => t.getTime() >= g.from.getTime() - tol && t.getTime() <= g.to.getTime() + tol);
    const afterStart = stateAt(new Date(b.start.getTime() + tol));
    if (afterStart !== 'on') {
      // only this block's own ON counts, never the next block's
      const nextOn = trans.find((t) => t.value === 'on' && t.at.getTime() > b.start.getTime() && t.at.getTime() < b.end.getTime());
      out.push({ kind: 'missed-on', block: label, minutes: nextOn ? mins(nextOn.at, b.start) : undefined, detail: nextOn ? 'turned on late' : 'never turned on inside the block' });
      bad = true;
    }
    for (const t of trans) {
      if (t.value === 'off' && t.at.getTime() > b.start.getTime() + tol && t.at.getTime() < b.end.getTime() - tol && !inGap(t.at)) {
        out.push({ kind: 'early-exit', block: label, minutes: mins(t.at, b.end), detail: 'turned off inside the block' });
        bad = true;
      }
    }
    for (const g of gaps) {
      if (stateAt(new Date(g.to.getTime() + tol)) !== 'on') {
        const next = trans.find((t) => t.value === 'on' && t.at.getTime() > g.from.getTime() && t.at.getTime() < b.end.getTime());
        out.push({ kind: 'missed-reon', block: label, minutes: next ? mins(next.at, g.to) : undefined, detail: next ? 're-ON after the Saturday OFF came late' : 'no re-ON after the Saturday OFF; the holiday is unprotected' });
        bad = true;
      }
    }
    const afterEnd = stateAt(new Date(b.end.getTime() + tol));
    if (afterEnd === 'on') {
      out.push({ kind: 'late-exit', block: label, detail: 'still on after the scheduled OFF' });
      bad = true;
    }
    if (!bad) out.push({ kind: 'ok', block: label, detail: 'on at the start and off at the end as scheduled' });
  }
  for (const t of trans) {
    if (t.value !== 'on' || t.at.getTime() < first || t.at.getTime() > last) continue;
    const inside = blocks.some((b) => t.at.getTime() >= b.start.getTime() - tol && t.at.getTime() <= b.end.getTime() + tol);
    if (!inside) out.push({ kind: 'unexplained-on', block: '-', detail: 'turned on outside any scheduled block (manual or fridge-internal)' });
  }
  return out;
}

/** Sanitized one-line summary: counts only, no timestamps, ids or coordinates. Safe for a public repo. */
export function summarize(findings: Finding[]): string {
  const c = new Map<FindingKind, number>();
  for (const f of findings) c.set(f.kind, (c.get(f.kind) ?? 0) + 1);
  return [...c.entries()].map(([k, n]) => `${k}: ${n}`).join(', ') || 'no findings';
}
