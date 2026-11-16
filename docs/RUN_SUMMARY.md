# Run summary modules

Run `python3 scripts/ci/run_summary.py` from the repository root, as before.
The entry point and startup self-test stay in that file. The script adds
its own directory to the import path so file-location imports work too.

- `run_summary_jobs.py`: job API durations and workflow metadata.
- `run_summary_changes.py`: event ranges and coverage-map parsing.
- `run_summary.py`: output assembly, escaping, startup self-test and map access.

Functions and constants keep their original bodies and values. Map access
stays in the entry module so callers can still override the map-path constant there.
The `urllib.request` import remains available there for existing mocks.

The offline regression suite checks API errors, map-path overrides, summary
sections, escaping and fail-safe behavior. All files stay within the
code-layout source and test limits.
