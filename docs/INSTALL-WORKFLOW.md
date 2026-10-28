# Install the holiday rules with GitHub Actions / התקנת חוקי החגים עם GitHub Actions

The workflow **Install holiday rules** (`.github/workflows/install-rules.yml`) creates or updates the SmartThings
rules named `shabbat-fridge holidays YYYY` (one per year, 10 years) and, only if you turn on `weekly_rules`, one rule named
`shabbat-fridge weekly`. It never touches any other rule (your own weekly Shabbat rules stay as they are). It starts as a dry run.

הפעולה **Install holiday rules** יוצרת או מעדכנת רק חוקים בשם `shabbat-fridge holidays YYYY` (חוק לכל שנה), ורק אם הפעלת `weekly_rules` גם חוק אחד בשם `shabbat-fridge weekly`.
היא לא נוגעת באף חוק אחר, כולל חוקי השבת השבועיים שלך. ברירת המחדל היא הרצה יבשה (בלי כתיבה).

## 1. Create the SmartThings token / יצירת הטוקן

1. Open https://account.smartthings.com/tokens and sign in with your Samsung account.
2. **Generate new token**, name it `shabbat-rules`.
3. Tick only these scopes / סמן רק:
   - Rules: read, write, execute (`r:rules:*`, `w:rules:*`, `x:rules:*`)
   - Devices: list and see (`r:devices:*`)
   - Locations: see (`r:locations:*`)
   Do not tick device control (`x:devices`). The rules run on Samsung's side; this token never sends a command to the fridge.
4. Copy the token. A token is valid for 24 hours, so do the next steps now. It is shown once.

פתחו את הקישור, צרו טוקן חדש עם ההרשאות למעלה (בלי שליטה במכשירים), והעתיקו אותו. הטוקן תקף ל-24 שעות.

## 2. Save it as a GitHub secret / שמירה כ-Secret

In the repository: **Settings > Secrets and variables > Actions > New repository secret**.
Name: `SMARTTHINGS_TOKEN`. Value: the token. (You need write access to the repo.)
Or with the GitHub CLI: `gh secret set SMARTTHINGS_TOKEN --repo reihlinstinct/shabbat-fridge`

The workflow reads it as a secret. It is masked in logs, is not available to pull requests from forks, and is never printed.
Do not paste the token into the workflow inputs (inputs are visible in the run).

## 3. Run it: dry run first / הרצה

**Actions > Install holiday rules > Run workflow.** Leave **Dry run** ticked and run.
Open the run summary. It lists: calendar (Israel or Diaspora), time zone, offsets, and the plan
(create / update / unchanged / remove), plus how many other rules are left alone. Nothing is written.

Then run again with **Dry run** unticked to apply. The job reads the rules back and prints
`rules match the plan; other rules unchanged: true`. The read-back check runs after the writes. If it prints MISMATCH, the rules were already written and may differ from the plan (your other rules are never touched); run the workflow again with the default dry run to see exactly what differs, then fix or re-apply.

Defaults: ON 60 minutes before sunset, OFF 90 minutes after, re-ON 100 minutes after sunset on a Saturday followed by a
holiday, Yom Kippur included, 10 years. Location, country, time zone and the fridge are read from SmartThings
(the one location, and the single device with `samsungce.sabbathMode`). If you have several, the run stops and says what to set.

Running again is safe: with no changes the plan is empty.

## 4. Revoke it / ביטול

- Delete the token at https://account.smartthings.com/tokens (it expires by itself after 24 hours).
- Delete the secret: **Settings > Secrets and variables > Actions**, delete `SMARTTHINGS_TOKEN`
  (or `gh secret delete SMARTTHINGS_TOKEN --repo reihlinstinct/shabbat-fridge`).

The rules already installed keep running on Samsung's servers after the token is gone.

## Generate the JSON only / יצירת ה-JSON בלבד

**Actions > Generate holiday rules JSON > Run workflow.** It needs no token. It computes 10 rolling years from today with the
calendar core, cross-checks every Yom Tov day against the public Hebcal web API (it fails if they disagree), and uploads
an artifact `holiday-rules` with `holiday-rules.json` (a placeholder device id: `YOUR-DEVICE-ID`) and an annotated
`holiday-schedule.md` (Hebrew and English holiday names, Hebrew dates, each ON/OFF with its sunset offset).
Defaults are Jerusalem and the Israel calendar; change latitude, longitude, time zone or choose calendar = diaspora for another place.

The install workflow does not use this artifact: it recomputes the same rules itself, reading the location (country, time zone,
coordinates) and the fridge from your SmartThings account, and runs the same Hebcal cross-check before writing anything.
יצירת ה-JSON לא דורשת טוקן. הפעולה של ההתקנה מחשבת את אותם חוקים בעצמה ומשווה מול Hebcal לפני כתיבה.

Rolling horizon: run the install workflow again any time (for example once a year). It extends the 10 years from the day it
runs, replaces only our `shabbat-fridge holidays YYYY` rules, and with **Prune** also removes our rules for past years.

## Second day of Yom Tov outside Israel / יום טוב שני של גלויות

Both workflows have a `calendar` input. Default for **Install** is `auto`: Israel (one day of Yom Tov) when the SmartThings
location country is Israel, Diaspora otherwise. `auto` stops with an error when SmartThings gives no recognisable country; then choose `israel` or `diaspora` yourself. Choose `diaspora` to add the second day of Yom Tov (Yom Tov Sheni shel
Galuyot), for example when you keep it while visiting abroad, or when your location is set outside Israel but you want it
explicitly. Choose `israel` to force one day. For **Generate** the default is `israel`; `diaspora` gives two days.
The Hebcal cross-check uses the same choice (`i=on` for Israel, `i=off` for Diaspora). Dates follow the Hebrew calendar rules in
the calendar core; known dates are in the tests (for example Diaspora 2026-10-03 and 2026-10-04).
ברירת המחדל: ישראל, יום טוב אחד. לבחירת יום טוב שני: calendar = diaspora.
## After a real run / אחרי הרצה אמיתית

Run the workflow once more with the default dry run. The plan should say `unchanged` for every rule (create 0, update 0, remove 0).
If it shows `update` for rules you just wrote, SmartThings normalized something differently from the plan: open an issue with the summary.
The time zone stays explicit: it comes from your SmartThings location, never from the runner.

## Important limit / מגבלה חשובה

The +100 re-ON after a Saturday that is followed by a holiday assumes the weekly Saturday OFF rule fires at +90 minutes or earlier.
If your weekly OFF is later than +100 (or removed), the re-ON would fire before it and the OFF would then turn Sabbath mode off during the holiday.
Keep the weekly OFF at +90 or earlier, or lower re-ON accordingly.

## How the dates are tested / איך התאריכים נבדקים

`test/fixtures/hebcal-yomtov.json` pins every Yom Tov day for 2026-2126 (Israel and Diaspora) from the Hebcal web API. The tests
(`test/hundred-years.test.ts`) check our calendar against it day by day for 100 years, then check that the generated rules equal
entries derived from those dates by plain day arithmetic: eve ON at -60, OFF at +90, no rule for a Saturday-only holiday, and a +100
re-ON for a Saturday inside a block. A seeded random sample and one holiday per year for 2027-2036 are checked in the JSON as well.
The workflow **Check Hebcal fixture** (manual, and every January 1; GitHub may disable scheduled workflows after 60 days without repository activity, so the schedule is best effort and a manual run is the dependable path) re-fetches the data and fails if Hebcal changed;
refresh with `npx tsx scripts/refresh-fixture.ts`.
Limit: Hebcal and our calendar core both use the same Hebrew calendar rules (the standard fixed calendar), so this guards against
bugs and drift, not against a different halachic custom.

## Optional weekly Shabbat rule / חוק שבת שבועי (אופציונלי)

Input `weekly_rules` (default **off**) in both workflows adds one rule named `shabbat-fridge weekly`: Friday ON at sunset minus the entry
offset (60) and Saturday OFF at sunset plus the exit offset (90), repeating every week. Use it when the fridge has no weekly rules yet.
If you already have your own weekly rules (for example "Shabbat mode" and "Weekday Mode"), leave it off: they stay untouched.
Running the install workflow with it on creates the rule once; running it again shows `unchanged`. Turning the input off later does not
delete it (Prune only removes yearly holiday rules); delete it in SmartThings if you no longer want it.

Interplay with the holiday re-ON: the +100 re-ON on a Saturday before a holiday only works if the weekly Saturday OFF fires **before** it.
So the weekly OFF offset must be smaller than the re-ON offset: the workflow refuses `exit >= re-ON`. If one of your own weekly rules turns
the mode off at or after the re-ON, the install summary prints a WARNING, because that rule would end the holiday early.

### Late OFF: what to change / מה לשנות

If the WARNING appears, a weekly OFF fires at or after the re-ON. Either raise the re-ON offset above that OFF (input `reenter_minutes_after_sunset`),
or lower the weekly OFF (move your own rule or the `exit_minutes_after_sunset` input). The check looks at the rules that will exist after the run
(your own rules, our weekly rule if it stays, and any unchanged rules), for this fridge only, and honors Minute and Hour offsets.
The hard refusal (exit must be smaller than re-ON) runs only when `weekly_rules` is on, because only then do we create the OFF. With it off, you get the WARNING only.
Prune removes yearly holiday rules; it does not remove `shabbat-fridge weekly`. If the weekly rule ever exists twice, the plan removes the duplicate copies
(same name) and keeps one, with or without Prune.
