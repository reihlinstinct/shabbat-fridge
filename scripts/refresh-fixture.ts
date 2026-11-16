/**
 * Refresh test/fixtures/hebcal-yomtov.json: every Yom Tov day for 100 years from the Hebcal web API
 * (independent of our calendar core), for the Israel (i=on) and Diaspora (i=off) calendars.
 * Usage: npx tsx scripts/refresh-fixture.ts [firstYear=2026] [lastYear=2126]
 */
import { writeFileSync } from 'node:fs';

const first = Number(process.argv[2] ?? 2026);
const last = Number(process.argv[3] ?? 2126);
type Item = { date: string; title: string; yomtov?: boolean };

async function year(y: number, israel: boolean): Promise<Item[]> {
  const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=off&nx=off&ss=off&mf=off&year=${y}&month=x&i=${israel ? 'on' : 'off'}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return ((await res.json()) as { items?: Item[] }).items ?? [];
    if (attempt >= 4) throw new Error(`Hebcal HTTP ${res.status} for ${y}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

const out: Record<string, { yomtov: string[]; yomKippur: string[] }> = {};
for (const [name, israel] of [['israel', true], ['diaspora', false]] as const) {
  const yomtov = new Set<string>();
  const yk = new Set<string>();
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  for (let i = 0; i < years.length; i += 5) {
    const batch = await Promise.all(years.slice(i, i + 5).map((y) => year(y, israel)));
    for (const items of batch) {
      for (const it of items) {
        if (!it.yomtov) continue;
        yomtov.add(it.date.slice(0, 10));
        if (it.title === 'Yom Kippur') yk.add(it.date.slice(0, 10));
      }
    }
  }
  out[name] = { yomtov: [...yomtov].sort(), yomKippur: [...yk].sort() };
}
writeFileSync(new URL('../test/fixtures/hebcal-yomtov.json', import.meta.url), JSON.stringify({ source: 'https://www.hebcal.com/hebcal (v=1, cfg=json, maj=on, yomtov flag)', firstYear: first, lastYear: last, ...out }, null, 1) + '\n');
console.log(`israel ${out.israel!.yomtov.length} days, diaspora ${out.diaspora!.yomtov.length} days, ${first}-${last}`);
