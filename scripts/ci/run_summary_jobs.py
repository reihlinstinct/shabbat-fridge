"""Job durations and workflow-job metadata for run_summary.py."""

import datetime
import json
import os
import re
import urllib.error
import urllib.request

# Section: Job metadata and durations


def job_durations(env):
    """job name -> seconds, from the public jobs API. Empty on any failure."""
    token = env.get("GITHUB_TOKEN", "")
    repo = env.get("GITHUB_REPOSITORY", "")
    run_id = env.get("GITHUB_RUN_ID", "")
    api = env.get("GITHUB_API_URL", "")
    if not repo or not run_id or not api:
        return {}
    url = f"{api}/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return {}
    durations = {}
    if not isinstance(data, dict):
        return durations
    for job in data.get("jobs", []):
        if not isinstance(job, dict):
            continue
        started, completed = job.get("started_at"), job.get("completed_at")
        if not started or not completed:
            continue
        try:
            t0 = datetime.datetime.fromisoformat(started)
            t1 = datetime.datetime.fromisoformat(completed)
        except ValueError:
            continue
        durations[job.get("name", "")] = (t1 - t0).total_seconds()
    return durations


def _yaml_plain_scalar(text):
    """Strip a trailing comment from an unquoted YAML scalar: in a plain
    scalar, ` #` starts a comment (name: X (issue #14) parses as X
    (issue). Quoted scalars are returned unchanged."""
    if text.startswith(("'", '"')):
        return text
    return text.split(" #", 1)[0].rstrip()


def _job_display_name(raw):
    """Static job display name from a raw `name:` value, or None.

    Plain-scalar comments are stripped first: a comment containing an
    expression (name: X # ${{ ... }}) does not make the static name
    dynamic; a real expression in the value rejects the name."""
    name = _yaml_plain_scalar(raw)
    return None if "${{" in name else name


def _parse_job_meta_lines(lines):
    """(job id -> `if:` expression, job id -> static display name) parsed
    from workflow file lines. Only a nonblank, noncomment column-0 line
    ends the jobs block: blank lines and column-0 comments between jobs
    are common and must not drop the later jobs."""
    conditions = {}
    names = {}
    current = None
    in_jobs = False
    for line in lines:
        if re.match(r"^jobs:\s*(?:#.*)?$", line):
            in_jobs = True
            continue
        if in_jobs:
            m = re.match(
                r"^  (?:'([^']*)'|\"([^\"]*)\"|([A-Za-z0-9_.-]+))"
                r":\s*(?:#.*)?$",
                line,
            )
            if m:
                # YAML permits quoted keys; a quoted job id is the id
                # without its quotes.
                current = m.group(1) or m.group(2) or m.group(3)
                continue
            stripped = line.strip()
            if stripped and not stripped.startswith("#") \
                    and not line.startswith(" "):
                in_jobs = False
                current = None
                continue
            if stripped and not stripped.startswith("#") \
                    and re.match(r"^  \S", line):
                # Unrecognized job-level key (e.g. a quoted id): do not
                # attribute later if:/name: lines to the previous job.
                current = None
                continue
            m = re.match(r"^    if:\s*(.+?)\s*$", line)
            if m and current:
                conditions[current] = m.group(1)
                continue
            m = re.match(r"^    name:\s*(.+?)\s*$", line)
            if m and current:
                name = _job_display_name(m.group(1))
                if name:
                    names[current] = name
    return conditions, names


def load_job_meta(env):
    """Job metadata parsed from the workflow file named by
    GITHUB_WORKFLOW_REF."""
    ref = env.get("GITHUB_WORKFLOW_REF", "")
    path = ref.split("@")[0].split("/", 2)[-1] if "@" in ref else ""
    if not path or not os.path.exists(path):
        return {}, {}
    try:
        with open(path, encoding="utf-8") as fh:
            return _parse_job_meta_lines(fh)
    except OSError:
        return {}, {}


def duration_for(job_id, durations, display_names):
    """Seconds for one needs-context job id, matched against API display
    names: exact id, then a static workflow `name:`, then matrix children
    ("<id> (<value>)"). None when nothing matches."""
    candidates = [job_id]
    disp = display_names.get(job_id)
    if disp and disp != job_id:
        candidates.append(disp)
    total = 0.0
    found = False
    for cand in candidates:
        if cand in durations:
            total += durations[cand]
            found = True
        else:
            children = [v for n, v in durations.items()
                        if n.startswith(cand + " (")]
            if children:
                total += sum(children)
                found = True
    return total if found else None
