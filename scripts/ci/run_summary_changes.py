"""Change ranges and coverage-map loading for run_summary.py."""

import json
import os
import re

# Section: Change ranges


def load_event(env):
    path = env.get("GITHUB_EVENT_PATH", "")
    if path and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def changed_ranges(env, event):
    """(log range, diff range) for this run, or None.

    On pull_request, GITHUB_SHA is the synthetic merge commit, so it
    would add a "Merge ..." entry to the commit list: list commits
    base..head and diff files base...head (merge base) instead. On push,
    before..after serves both."""
    name = env.get("GITHUB_EVENT_NAME", "")
    if name == "pull_request":
        pr = event.get("pull_request") or {}
        base = (pr.get("base") or {}).get("sha", "")
        head = (pr.get("head") or {}).get("sha", "")
        if base and head:
            return f"{base}..{head}", f"{base}...{head}"
        return None
    if name == "push":
        # Use the payload's after, not GITHUB_SHA: on a branch deletion
        # after is all zeros while GITHUB_SHA points at the default
        # branch, which would list and diff unrelated commits.
        before = event.get("before", "")
        after = event.get("after", "")
        if (before and set(before) != {"0"}
                and after and set(after) != {"0"}):
            return f"{before}..{after}", f"{before}..{after}"
    return None


def _no_range_reason(env, event):
    """Why there is no change range, for the summary body."""
    after = event.get("after", "") if isinstance(event, dict) else ""
    if env.get("GITHUB_EVENT_NAME", "") == "push" \
            and after and set(after) == {"0"}:
        return ("This push deleted the ref (`after` is all zeros), "
                "so there is no change range to diff.")
    return "No change range is available for this run."


# Section: Coverage map

MAP_PATH = ".github/ci-coverage-map.json"


def glob_to_regex(pattern):
    """Translate a gitignore-style glob to a regex. `**` crosses directories,
    `*` and `?` stay within one path segment."""
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if pattern[i:i + 2] == "**":
                i += 2
                if pattern[i:i + 1] == "/":
                    i += 1
                    out.append("(?:.*/)?")
                else:
                    out.append(".*")
            else:
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            j = pattern.find("]", i)
            out.append(pattern[i:j + 1] if j != -1 else "\\[")
            i = j + 1 if j != -1 else i + 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def _map_entries(data):
    """(regex, pattern, checks) per well-formed mapping entry; anything
    else in the file is ignored so a broken map degrades the coverage
    section instead of failing the job."""
    mappings = []
    entries = data.get("mappings", []) if isinstance(data, dict) else []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        pattern = entry.get("pattern", "")
        checks = entry.get("checks", [])
        if not isinstance(pattern, str) or not pattern:
            continue
        if not isinstance(checks, list):
            checks = []
        else:
            checks = [c for c in checks if isinstance(c, str) and c]
        try:
            rx = glob_to_regex(pattern)
        except re.error:
            continue
        mappings.append((rx, pattern, checks))
    return mappings




STATUS_WORD = {"A": "added", "M": "modified", "D": "deleted",
               "R": "renamed", "C": "copied", "T": "type changed"}


def _parse_needs(raw):
    """job id -> needs context dict, from NEEDS_JSON; {} unless the
    payload is an object whose values are objects."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)}
