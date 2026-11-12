# Accessibility statement

Our target is SI 5568 level AA, with additional WCAG 2.2 A/AA automated coverage.
No complete conformance audit has been completed.

## Evidence

The repository ships a static authorization callback at docs/oauth-callback.html.
The pinned repo-checks axe action tests its invented code/state, error and missing
code states in Chromium and WebKit at 1280x900 and 390x844: 12 states. The regression
also checks query removal and expected synthetic message visibility. No real
account, authorization code, appliance or sign-in is used. The hidden code element now stays hidden in missing/error states; its previous
CSS display rule overrode the hidden attribute. Authorization behavior is unchanged.

The preview serves only the callback on 127.0.0.1. It is a first-party synthetic/
no-secret test, not network isolation; unsupported browser network paths remain
outside the shared runner contract.

## Known limits

Manual keyboard, screen-reader, zoom/reflow, mixed-language pronunciation and
real-device checks remain open. WebKit on Linux is not iOS Safari. Two browser
engines do not prove native two-OS coverage or legal compliance. Appliance-control
flows and vendor authorization pages are outside this static page test.

## Feedback

Report barriers and reproducible steps through the repository Issues page:
https://github.com/reihlinstinct/shabbat-fridge/issues
Never include real authorization codes, tokens or account details.

The preview contract uses the project Vitest runner. CI pins the shared remote
action and the separate state-check tools to the same reviewed commit; the
state checker installs only that lockfile. The documented scanner path is
development-only, not appliance configuration.

Browser CI uses a digest-pinned official Playwright 1.65.0 runtime matching the
shared tools lockfile. The preinstalled mode still launches and renders in both
engines before axe scans. Missing browsers or libraries fail CI; no browser
cache, apt mirror fetch or skipped test substitutes for these checks. Update
the image digest and matching tool lockfiles together.
