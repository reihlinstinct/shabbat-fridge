# shabbat-fridge

Sets Shabbat / Yom Tov mode on Samsung SmartThings appliances (first target: a Samsung fridge) from the
Jewish calendar and local sunset, instead of relying on the appliance's built-in weekly Shabbat timer.

**Status: design phase.** The code computes and diffs rules; nothing here writes to SmartThings yet. See
[docs/DESIGN.md](docs/DESIGN.md) and [docs/RESEARCH.md](docs/RESEARCH.md).

## The problem

The fridge's built-in Shabbat mode runs weekly, around sunset. It does not know about Yom Tov, and a Yom Tov
that touches Shabbat can take the fridge out of the mode in the middle of the holiday.

## What exists today

`src/blocks.ts` computes the "no-touch" blocks for any location:

- Shabbat plus Yom Tov days, merged when adjacent (Yom Tov next to Shabbat is one block).
- Israel calendar (one day of Yom Tov) or Diaspora (two days), a setting of the place.
- Latitude, longitude and time zone are inputs. Nothing is hardcoded to Jerusalem.
- Entry (default 10 min before sunset) and exit (default 40 min after sunset) are options.

```
npm ci
npm test
npm run typecheck
```

`scripts/generate.ts` writes the Rules JSON from environment settings (no private data in the repo).

`src/rules.ts` turns blocks into dated, Sunset-relative SmartThings Rules actions and diffs them against existing rules (dry run).

Calendar and sunset data come from [@hebcal/core](https://github.com/hebcal/hebcal-es6) and run fully offline.

## Disclaimer

Not a halachic authority. Defaults (Yom Kippur, offsets) are settings. Confirm with your own rabbi.

License: MIT.
