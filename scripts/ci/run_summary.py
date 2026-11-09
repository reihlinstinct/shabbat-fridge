#!/usr/bin/env python3
"""Append a run summary to GITHUB_STEP_SUMMARY.

Stdlib-only and deterministic. Sections:
1. Jobs: result and duration per job, totals, skipped jobs with their
   if-conditions (durations via the public jobs API when reachable).
2. What changed: commits and changed files for push / pull_request runs.
3. Coverage: changed files mapped to the checks that cover them via
   .github/ci-coverage-map.json; files matching no mapping are listed as
   changed without declared coverage.

Everything is best-effort: a missing piece of context degrades one section,
never the job. The one stop condition is the startup self-test: a failure
means the tool itself is defective, so the job fails loudly instead of
writing a wrong summary. Nothing else in this step may fail the workflow.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request  # noqa: F401 - compatibility: callers patch this module

# The script's own directory holds the sibling modules it is split
# into; put it on sys.path so direct runs and importlib file-location
# loads (unit tests) both resolve them.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from run_summary_changes import (
    MAP_PATH,
    STATUS_WORD,
    _map_entries,
    _no_range_reason,
    _parse_needs,
    changed_ranges,
    glob_to_regex,
    load_event,
)
from run_summary_jobs import (
    _job_display_name,
    _parse_job_meta_lines,
    _yaml_plain_scalar,
    duration_for,
    job_durations,
    load_job_meta,
)

# Section: Entry point

def main():
    try:
        _self_test()
    except AssertionError:
        sys.exit("run_summary.py self-test failed; the summary tool is "
                 "defective, not writing a summary")
    env = os.environ
    out = []
    repo = env.get("GITHUB_REPOSITORY", "")
    server = env.get("GITHUB_SERVER_URL", "")
    sha = env.get("GITHUB_SHA", "")
    workflow = env.get("GITHUB_WORKFLOW", "")

    out.append(f"## Run summary - {workflow}\n")
    out.append(f"- Event: `{env.get('GITHUB_EVENT_NAME', '')}`")
    if repo and sha and server:
        out.append(f"- Commit: [`{sha[:7]}`]({server}/{repo}/commit/{sha})")
    elif sha:
        out.append(f"- Commit: `{sha[:7]}`")

    # --- Jobs -------------------------------------------------------------
    needs = _parse_needs(env.get("NEEDS_JSON", "{}"))
    durations = job_durations(env)
    conditions, display_names = load_job_meta(env)
    if needs:
        out.append("\n### Jobs\n")
        out.append("| Job | Result | Duration |")
        out.append("| --- | --- | --- |")
        counts = {}
        total = 0.0
        for job in sorted(needs):
            result = needs[job].get("result", "unknown")
            counts[result] = counts.get(result, 0) + 1
            dur = duration_for(job, durations, display_names)
            if dur is not None:
                total += dur
            out.append(f"| `{job}` | {result} | "
                       f"{fmt_dur(dur) if dur is not None else 'n/a'} |")
        out.append("")
        out.append("Totals: "
                   + ", ".join(f"{v} {k}" for k, v in sorted(counts.items()))
                   + ".")
        if total:
            out.append(f"Summed job time: {fmt_dur(total)} (each job is "
                       "billed rounded up to a whole minute; minutes on "
                       "public repos are free).")
        if not durations:
            out.append("Per-job durations unavailable (jobs API not "
                       "reachable with this token).")
        skipped = [j for j in sorted(needs)
                   if needs[j].get("result") == "skipped"]
        if skipped:
            out.append("\nSkipped jobs:")
            for job in skipped:
                cond = conditions.get(job)
                out.append(f"- `{job}`" +
                           (f" - runs only if {md_escape(cond)}"
                            if cond else
                            " - its condition was not met"))
    else:
        out.append("\nNo upstream jobs declared in `needs`.")

    # --- What changed -----------------------------------------------------
    event = load_event(env)
    ranges = changed_ranges(env, event)
    files = []
    if ranges:
        log_rng, diff_rng = ranges
        out.append(f"\n### What changed in this run (`{diff_rng}`)\n")
        try:
            log = sh("git", "log", "--format=%h %s", log_rng).strip()
            out.append("Commits:")
            # _log_rows splits raw bytes on b"\n" only: neither
            # universal-newlines decoding nor CR/U+2028/U+2029 in a
            # subject can smuggle a forged extra row.
            for short, subject in _log_rows(log):
                out.append(f"- `{md_escape(short)}` {md_escape(subject)}")
            # -z: NUL-delimited, no quoting of non-ASCII paths.
            diff = sh("git", "diff", "--name-status", "-z", diff_rng)
            records = [r.decode("utf-8", "replace")
                       for r in diff.split(b"\x00") if r]
            i = 0
            while i < len(records):
                status = records[i]
                if status.startswith(("R", "C")):
                    i += 1  # skip old path; report the new one
                if i + 1 > len(records) - 1:
                    break
                files.append((status[0], records[i + 1]))
                i += 2
        except subprocess.CalledProcessError:
            out.append("Diff unavailable in this checkout "
                       "(shallow history or missing base).")
    else:
        out.append("\n### What changed in this run\n")
        out.append(_no_range_reason(env, event))

    # --- Coverage ---------------------------------------------------------
    if files:
        mappings = load_map()
        out.append("\n### Coverage of the changes\n")
        if not mappings:
            out.append("Changed files (no coverage map in this repo; add "
                       f"`{MAP_PATH}` to declare which checks cover what):")
            for status, path in files:
                word = STATUS_WORD.get(status, status)
                out.append(f"- {md_escape(path)} ({word})")
        else:
            out.append("| File | Change | Checks covering it |")
            out.append("| --- | --- | --- |")
            uncovered = []
            for status, path in files:
                checks = []
                for regex, _pattern, mapped in mappings:
                    if regex.match(path):
                        checks.extend(c for c in mapped if c not in checks)
                word = STATUS_WORD.get(status, status)
                if checks:
                    out.append(f"| {md_escape(path)} | {word} | "
                               + ", ".join(f"`{c}`" for c in checks) + " |")
                else:
                    out.append(f"| {md_escape(path)} | {word} | - |")
                    uncovered.append(path)
            if uncovered:
                out.append("\nChanged without declared coverage (no "
                           f"check in `{MAP_PATH}` maps to these files):")
                for path in uncovered:
                    out.append(f"- {md_escape(path)}")
            else:
                out.append("\nEvery changed file matches at least one "
                           "coverage mapping.")

    text = "\n".join(out) + "\n"
    summary = env.get("GITHUB_STEP_SUMMARY", "")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)


# Section: General helpers

def sh(*args):
    """Raw bytes. Decoding and splitting happen at the call site, so an
    embedded carriage return or invalid UTF-8 in a commit subject or
    filename cannot forge an extra record (text=True would translate
    CR to a line break)."""
    return subprocess.run(list(args), capture_output=True,
                          check=True).stdout

def fmt_dur(seconds):
    seconds = round(seconds)
    if seconds < 60:
        return f"{seconds}s"
    return f"{seconds // 60}m {seconds % 60:02d}s"

def _log_rows(log):
    """(short hash, subject) per raw git-log record. The byte split on
    b"\n" happens before decoding, so CR/U+2028/U+2029 in a subject
    cannot forge an extra row."""
    for raw in log.split(b"\n") if log else [b"(none)"]:
        line = raw.decode("utf-8", "replace")
        short, _, subject = line.partition(" ")
        yield short, subject

def md_escape(text):
    """Render untrusted text (commit subjects, file paths, if-conditions)
    as literal text in the step summary: control characters, newlines
    and the Unicode line/paragraph separators (U+2028/U+2029, which
    str.splitlines also splits on) become spaces, HTML metacharacters
    become entities (the summary renders raw HTML), and the Markdown
    metacharacters that could break out of a table cell, code span or
    link are backslash-escaped."""
    text = "".join(
        ch if (ch >= " " and ch not in "\x7f\x85\u2028\u2029") else " "
        for ch in text)
    text = (text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))
    return (text.replace("\\", "\\\\")
            .replace("`", "\\`")
            .replace("|", "\\|")
            .replace("[", "\\[")
            .replace("]", "\\]"))


# Section: Startup self-test

def _self_test():
    """Regression checks for the summary tooling itself. Runs on every
    invocation; a failure means the tool is defective, so the job stops."""
    assert md_escape("a`b|c\nd[e]f\\g") == "a\\`b\\|c d\\[e\\]f\\\\g"
    assert md_escape("<b>&") == "&lt;b&gt;&amp;"
    assert md_escape("<a href='x'>y</a>") == "&lt;a href='x'&gt;y&lt;/a&gt;"
    assert md_escape("a\u2028b\u2029c") == "a b c"
    # the forged-row scenario: U+2028 in a subject must not split the
    # log line, and any remaining fragment stays escaped literal text
    forged = "deadbee real \u2028` | [x](/forged-link) | forged"
    assert forged.split("\n") == [forged]
    short, _, subject = forged.partition(" ")
    rendered = f"- `{short}` {md_escape(subject)}"
    assert rendered.count("\n") == 0 and "\u2028" not in rendered 
    assert md_escape("\x00\x1f\r\n") == "    "
    assert md_escape("plain text") == "plain text"
    dur = {"test (3.11)": 60.0, "test (3.12)": 70.0, "lint": 30.0,
           "Build the thing": 200.0}
    assert duration_for("test", dur, {}) == 130.0
    assert duration_for("build", dur, {"build": "Build the thing"}) == 200.0
    assert duration_for("lint", dur, {}) == 30.0
    assert duration_for("missing", dur, {}) is None
    assert glob_to_regex("scripts/*.ts").match("scripts/x.ts")
    assert not glob_to_regex("scripts/*.ts").match("scripts/ci/x.py")
    assert glob_to_regex("a/**").match("a/b/c")
    assert _yaml_plain_scalar("Language shootout (issue #14)") == \
        "Language shootout (issue"
    assert _yaml_plain_scalar('"a # b"') == '"a # b"'
    assert _job_display_name("Build things # ${{ matrix.x }}") == \
        "Build things"
    assert _job_display_name("Test (${{ matrix.py }})") is None
    assert b"a \rb".split(b"\n") == [b"a \rb"]  # CR forges no row
    # CR/U+2028 rows through the full sh() -> _log_rows() pipeline
    assert list(_log_rows(sh("printf", "deadbee real \r subject"))) == \
        [("deadbee", "real \r subject")]
    assert list(_log_rows(sh("printf", "deadbee a\u2028b"))) == \
        [("deadbee", "a\u2028b")]
    assert sh("printf", "a\rb") == b"a\rb"  # bytes end to end
    conds, names = _parse_job_meta_lines([
        "jobs:\n",
        "  a:\n",
        "    if: github.ref == 'refs/heads/main'\n",
        "\n",
        "# a column-0 comment between jobs\n",
        "  b:\n",
        "    name: Build (issue #14)\n",
        "    if: always()\n",
    ])
    assert conds == {"a": "github.ref == 'refs/heads/main'",
                     "b": "always()"}
    assert names == {"b": "Build (issue"}
    conds, names = _parse_job_meta_lines([
        "jobs:\n",
        "  a:\n",
        "    if: github.ref == 'refs/heads/main'\n",
        "  b: # trailing comment\n",
        "    if: always()\n",
        "    name: Lint\n",
        "  'quoted-id':\n",
        "    name: Quoted\n",
        "    if: github.event_name == 'push'\n",
        "  c: {}\n",
        "    if: dropped()\n",
    ])
    assert conds == {"a": "github.ref == 'refs/heads/main'",
                     "b": "always()",  # trailing comment recognized
                     "quoted-id": "github.event_name == 'push'"}
    assert names == {"b": "Lint", "quoted-id": "Quoted"}
    # "c: {}" matches no header form: current cleared, if: dropped
    assert changed_ranges({"GITHUB_EVENT_NAME": "push"},
                          {"before": "abc", "after": "def"}) == \
        ("abc..def", "abc..def")
    assert changed_ranges({"GITHUB_EVENT_NAME": "push"},
                          {"before": "abc", "after": "0" * 40}) is None
    assert changed_ranges({"GITHUB_EVENT_NAME": "push"},
                          {"before": "0" * 40, "after": "def"}) is None
    assert "deleted the ref" in _no_range_reason(
        {"GITHUB_EVENT_NAME": "push"}, {"before": "abc", "after": "0" * 40})
    assert _no_range_reason({"GITHUB_EVENT_NAME": "push"},
                            {"before": "0" * 40, "after": "def"}) == \
        "No change range is available for this run."
    assert _no_range_reason({"GITHUB_EVENT_NAME": "workflow_dispatch"},
                            {}) == "No change range is available for this run."
    assert _no_range_reason({"GITHUB_EVENT_NAME": "push"}, {}) == \
        "No change range is available for this run."  # missing after
    assert list(_log_rows(b"")) == [("(none)", "")]
    assert changed_ranges({"GITHUB_EVENT_NAME": "pull_request"},
                          {"pull_request": {"base": None,
                                            "head": {"sha": "h"}}}) is None
    assert changed_ranges({"GITHUB_EVENT_NAME": "pull_request"},
                          {"pull_request": {"base": {"sha": "b"},
                                            "head": {"sha": "h"}}}) == \
        ("b..h", "b...h")
    entries = _map_entries({"mappings": [
        {"pattern": "src/**", "checks": ["test"]},
        {"pattern": "a[]b", "checks": ["x"]},  # invalid regex: skipped
        {"pattern": 3},                        # non-string: skipped
        "junk",                                # non-dict: skipped
        {"pattern": "docs/**", "checks": "docs"},  # non-list checks
    ]})
    assert [p for _rx, p, _c in entries] == ["src/**", "docs/**"]
    assert entries[1][2] == []
    assert _map_entries({"mappings": [
        {"pattern": "x/**", "checks": ["ok", None, 3, "", "fine"]},
    ]})[0][2] == ["ok", "fine"]
    assert _parse_needs("{") == {}
    assert _parse_needs("[]") == {}
    assert _parse_needs('{"a": {"result": "ok"}, "b": 3}') == \
        {"a": {"result": "ok"}}
    conds, _n = _parse_job_meta_lines([
        "jobs: # trailing comment\n",
        "  a:\n",
        "    if: always()\n",
    ])
    assert conds == {"a": "always()"}


# Section: Coverage map access

def load_map():
    try:
        with open(MAP_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    return _map_entries(data)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - deliberate fail-safe: a
        # summary must never fail the workflow, whatever broke.
        sys.stderr.write(f"run_summary: degraded: {exc}\n")
