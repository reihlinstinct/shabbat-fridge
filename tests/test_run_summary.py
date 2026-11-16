"""Offline regression tests for run-summary behavior and module compatibility."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

P = Path(__file__).resolve().parents[1] / "scripts/ci/run_summary.py"
spec = importlib.util.spec_from_file_location("run_summary", P)
rs = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rs
spec.loader.exec_module(rs)

REAL_SH = rs.sh  # _self_test pipes through printf; fakes must delegate those


class FakeResponse:
    def __init__(self, payload, raw=None):
        self.payload = payload
        self.raw = raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        if self.raw is not None:
            return self.raw
        return json.dumps(self.payload).encode("utf-8")


# Section: PureFunctionTests


class PureFunctionTests(unittest.TestCase):
    def test_fmt_dur_boundaries(self):
        self.assertEqual(rs.fmt_dur(0), "0s")
        self.assertEqual(rs.fmt_dur(59.4), "59s")
        self.assertEqual(rs.fmt_dur(60), "1m 00s")
        self.assertEqual(rs.fmt_dur(125), "2m 05s")

    def test_glob_to_regex(self):
        self.assertTrue(rs.glob_to_regex("scripts/*.ts").match("scripts/x.ts"))
        self.assertFalse(rs.glob_to_regex("scripts/*.ts").match("scripts/ci/x.py"))
        self.assertFalse(rs.glob_to_regex("*.py").match("scripts/ci/x.py"))
        self.assertTrue(rs.glob_to_regex("a/**").match("a/b/c"))
        self.assertTrue(rs.glob_to_regex("**/x.py").match("a/b/x.py"))
        self.assertTrue(rs.glob_to_regex("a?c").match("abc"))
        self.assertFalse(rs.glob_to_regex("a?c").match("a/c"))
        self.assertTrue(rs.glob_to_regex("[ab]c").match("bc"))
        # unmatched '[' is passed through literally, not a regex error
        self.assertTrue(rs.glob_to_regex("a[bc").match("a[bc"))

    def test_yaml_plain_scalar(self):
        self.assertEqual(rs._yaml_plain_scalar("X (issue #14)"), "X (issue")
        self.assertEqual(rs._yaml_plain_scalar('"a # b"'), '"a # b"')
        self.assertEqual(rs._yaml_plain_scalar("'a # b'"), "'a # b'")

    def test_job_display_name(self):
        self.assertEqual(rs._job_display_name("Build things # ${{ matrix.x }}"),
                         "Build things")
        self.assertIsNone(rs._job_display_name("Test (${{ matrix.py }})"))
        self.assertEqual(rs._job_display_name("Lint"), "Lint")

    def test_md_escape(self):
        self.assertEqual(rs.md_escape("a`b|c\nd[e]f\\g"),
                         "a\\`b\\|c d\\[e\\]f\\\\g")
        self.assertEqual(rs.md_escape("<b>&"), "&lt;b&gt;&amp;")
        self.assertEqual(rs.md_escape("a b c"), "a b c")
        self.assertEqual(rs.md_escape("\x00\x1f\r\n"), "    ")
        self.assertEqual(rs.md_escape("plain text"), "plain text")

    def test_log_rows(self):
        rows = list(rs._log_rows(b"deadbee first\nabc1234 second"))
        self.assertEqual(rows, [("deadbee", "first"), ("abc1234", "second")])
        self.assertEqual(list(rs._log_rows(b"")), [("(none)", "")])
        # a CR inside a subject does not forge a row
        rows = list(rs._log_rows("deadbee real \r subject".encode()))
        self.assertEqual(rows, [("deadbee", "real \r subject")])

    def test_duration_for(self):
        dur = {"test (3.11)": 60.0, "test (3.12)": 70.0, "lint": 30.0,
               "Build the thing": 200.0}
        self.assertEqual(rs.duration_for("test", dur, {}), 130.0)
        self.assertEqual(rs.duration_for("build", dur,
                                         {"build": "Build the thing"}), 200.0)
        self.assertEqual(rs.duration_for("lint", dur, {"lint": "lint"}), 30.0)
        self.assertIsNone(rs.duration_for("missing", dur, {}))

    def test_parse_needs(self):
        self.assertEqual(rs._parse_needs("{"), {})
        self.assertEqual(rs._parse_needs("[]"), {})
        self.assertEqual(
            rs._parse_needs('{"a": {"result": "ok"}, "b": 3}'),
            {"a": {"result": "ok"}})

    def test_changed_ranges(self):
        self.assertEqual(
            rs.changed_ranges({"GITHUB_EVENT_NAME": "push"},
                              {"before": "abc", "after": "def"}),
            ("abc..def", "abc..def"))
        self.assertIsNone(rs.changed_ranges(
            {"GITHUB_EVENT_NAME": "push"}, {"before": "abc", "after": "0" * 40}))
        self.assertEqual(
            rs.changed_ranges({"GITHUB_EVENT_NAME": "pull_request"},
                              {"pull_request": {"base": {"sha": "b"},
                                                "head": {"sha": "h"}}}),
            ("b..h", "b...h"))
        self.assertIsNone(rs.changed_ranges(
            {"GITHUB_EVENT_NAME": "pull_request"},
            {"pull_request": {"base": None, "head": {"sha": "h"}}}))
        self.assertIsNone(rs.changed_ranges(
            {"GITHUB_EVENT_NAME": "workflow_dispatch"}, {}))

    def test_no_range_reason(self):
        self.assertIn("deleted the ref", rs._no_range_reason(
            {"GITHUB_EVENT_NAME": "push"}, {"before": "abc", "after": "0" * 40}))
        self.assertEqual(
            rs._no_range_reason({"GITHUB_EVENT_NAME": "push"},
                                {"before": "0" * 40, "after": "def"}),
            "No change range is available for this run.")
        self.assertEqual(
            rs._no_range_reason({"GITHUB_EVENT_NAME": "workflow_dispatch"}, {}),
            "No change range is available for this run.")

    def test_map_entries(self):
        entries = rs._map_entries({"mappings": [
            {"pattern": "src/**", "checks": ["test"]},
            {"pattern": "a[]b", "checks": ["x"]},
            {"pattern": 3},
            "junk",
            {"pattern": "docs/**", "checks": "docs"},
        ]})
        self.assertEqual([p for _rx, p, _c in entries], ["src/**", "docs/**"])
        self.assertEqual(entries[1][2], [])
        entries = rs._map_entries({"mappings": [
            {"pattern": "x/**", "checks": ["ok", None, 3, "", "fine"]}]})
        self.assertEqual(entries[0][2], ["ok", "fine"])
        self.assertEqual(rs._map_entries({"mappings": "junk"}), [])
        self.assertEqual(rs._map_entries("not a dict"), [])

    def test_parse_job_meta_lines_block_end(self):
        conds, names = rs._parse_job_meta_lines([
            "jobs:\n",
            "  a:\n",
            "    if: always()\n",
            "    name: A job\n",
            "on:\n",  # column-0 key ends the jobs block
            "  push:\n",
            "    if: dropped()\n",
        ])
        self.assertEqual(conds, {"a": "always()"})
        self.assertEqual(names, {"a": "A job"})

    def test_self_test_passes(self):
        rs._self_test()  # must not raise


# Section: JobDurationsTests


class JobDurationsTests(unittest.TestCase):
    def env(self, **over):
        base = {"GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r",
                "GITHUB_RUN_ID": "1", "GITHUB_API_URL": "https://api.example.invalid"}
        base.update(over)
        return base

    def test_missing_env_returns_empty(self):
        self.assertEqual(rs.job_durations({}), {})

    def test_api_error_returns_empty(self):
        with mock.patch.object(rs.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("down")):
            self.assertEqual(rs.job_durations(self.env()), {})

    def test_non_dict_payload_returns_empty(self):
        with mock.patch.object(rs.urllib.request, "urlopen",
                               return_value=FakeResponse(["junk"])):
            self.assertEqual(rs.job_durations(self.env()), {})

    def test_parses_durations_and_sends_token(self):
        payload = {"jobs": [
            {"name": "a", "started_at": "2026-11-02T10:00:00+00:00",
             "completed_at": "2026-11-02T10:01:05+00:00"},
            {"name": "no-times"},
            {"name": "bad", "started_at": "junk",
             "completed_at": "2026-11-02T10:01:05+00:00"},
            "junk",
        ]}
        captured = {}

        def fake_urlopen(req, timeout=10):
            captured["auth"] = req.get_header("Authorization")
            captured["url"] = req.full_url
            return FakeResponse(payload)

        with mock.patch.object(rs.urllib.request, "urlopen", fake_urlopen):
            durations = rs.job_durations(self.env())
        self.assertEqual(durations, {"a": 65.0})
        self.assertEqual(captured["auth"], "Bearer t")
        self.assertIn("/repos/o/r/actions/runs/1/jobs", captured["url"])


# Section: FileReadingTests


class FileReadingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cwd = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.cwd)

    def test_load_event(self):
        self.assertEqual(rs.load_event({}), {})
        missing = {"GITHUB_EVENT_PATH": str(self.root / "nope.json")}
        self.assertEqual(rs.load_event(missing), {})
        bad = self.root / "bad.json"
        bad.write_text("{invalid", encoding="utf-8")
        self.assertEqual(rs.load_event({"GITHUB_EVENT_PATH": str(bad)}), {})
        good = self.root / "event.json"
        good.write_text('{"before": "abc"}', encoding="utf-8")
        self.assertEqual(rs.load_event({"GITHUB_EVENT_PATH": str(good)}),
                         {"before": "abc"})

    def test_load_job_meta(self):
        self.assertEqual(rs.load_job_meta({}), ({}, {}))
        self.assertEqual(rs.load_job_meta(
            {"GITHUB_WORKFLOW_REF": "o/r/.github/workflows/missing.yml@ref"}),
            ({}, {}))
        wf = self.root / ".github/workflows"
        wf.mkdir(parents=True)
        (wf / "tests.yml").write_text(
            "jobs:\n  a:\n    if: always()\n    name: A job\n",
            encoding="utf-8")
        conds, names = rs.load_job_meta(
            {"GITHUB_WORKFLOW_REF": "o/r/.github/workflows/tests.yml@ref"})
        self.assertEqual(conds, {"a": "always()"})
        self.assertEqual(names, {"a": "A job"})

    def test_load_map(self):
        with mock.patch.object(rs, "MAP_PATH", str(self.root / "nope.json")):
            self.assertEqual(rs.load_map(), [])
        bad = self.root / "bad.json"
        bad.write_text("{invalid", encoding="utf-8")
        with mock.patch.object(rs, "MAP_PATH", str(bad)):
            self.assertEqual(rs.load_map(), [])
        good = self.root / "map.json"
        good.write_text('{"mappings": [{"pattern": "src/**", '
                        '"checks": ["test"]}]}', encoding="utf-8")
        with mock.patch.object(rs, "MAP_PATH", str(good)):
            entries = rs.load_map()
        self.assertEqual([p for _rx, p, _c in entries], ["src/**"])


# Section: MainTests


class MainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.summary = self.root / "summary.md"
        self.cwd = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.cwd)

    def run_main(self, env, sh=None, durations=None):
        patches = [mock.patch.dict(os.environ, env, clear=True),
                   mock.patch.object(rs, "job_durations",
                                     return_value=durations or {})]
        if sh is not None:
            patches.append(mock.patch.object(rs, "sh", sh))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        rs.main()
        return self.summary.read_text(encoding="utf-8")

    def base_env(self, **over):
        env = {"GITHUB_STEP_SUMMARY": str(self.summary),
               "GITHUB_WORKFLOW": "Tests",
               "GITHUB_EVENT_NAME": "workflow_dispatch",
               "GITHUB_SHA": "deadbeefcafe",
               "GITHUB_REPOSITORY": "o/r",
               "GITHUB_SERVER_URL": "https://github.example.invalid"}
        env.update(over)
        return env

    def test_no_needs_no_range(self):
        text = self.run_main(self.base_env())
        self.assertIn("## Run summary - Tests", text)
        self.assertIn("- Event: `workflow_dispatch`", text)
        self.assertIn("[`deadbee`](https://github.example.invalid/o/r/commit/"
                      "deadbeefcafe)", text)
        self.assertIn("No upstream jobs declared in `needs`.", text)
        self.assertIn("No change range is available for this run.", text)

    def test_commit_line_without_server(self):
        text = self.run_main(self.base_env(GITHUB_SERVER_URL="",
                                           GITHUB_REPOSITORY=""))
        self.assertIn("- Commit: `deadbee`", text)

    def test_jobs_table_totals_and_skipped(self):
        wf = self.root / ".github/workflows"
        wf.mkdir(parents=True)
        (wf / "tests.yml").write_text(
            "jobs:\n  slow:\n    if: github.event_name == 'push'\n"
            "  ok:\n    name: All good\n",
            encoding="utf-8")
        env = self.base_env(
            GITHUB_EVENT_NAME="push",
            GITHUB_WORKFLOW_REF="o/r/.github/workflows/tests.yml@ref",
            NEEDS_JSON=json.dumps({
                "ok": {"result": "success"},
                "slow": {"result": "skipped"},
                "broken": {"result": "failure"},
            }))
        text = self.run_main(env, durations={"All good": 125.0})
        self.assertIn("| `broken` | failure | n/a |", text)
        self.assertIn("| `ok` | success | 2m 05s |", text)
        self.assertIn("Totals: 1 failure, 1 skipped, 1 success.", text)
        self.assertIn("Summed job time: 2m 05s", text)
        self.assertIn("- `slow` - runs only if "
                      "github.event_name == 'push'", text)

    def test_durations_unavailable_note(self):
        env = self.base_env(NEEDS_JSON='{"ok": {"result": "success"}}')
        text = self.run_main(env, durations={})
        self.assertIn("Per-job durations unavailable", text)

    def test_push_change_sections_with_map(self):
        (self.root / "event.json").write_text(
            '{"before": "aaa", "after": "bbb"}', encoding="utf-8")
        (self.root / "map.json").write_text(
            '{"mappings": [{"pattern": "scripts/**", "checks": ["unittest"]}'
            ", {\"pattern\": \"tests/**\", \"checks\": []}]}",
            encoding="utf-8")

        def fake_sh(*args):
            if args[0] == "printf":
                return REAL_SH(*args)
            if args[:2] == ("git", "log"):
                return b"bbb subject one\naaa subject two"
            if args[:2] == ("git", "diff"):
                return b"M\x00scripts/ci/run_summary.py\x00" \
                       b"A\x00docs/new.md\x00" \
                       b"R100\x00tests/old.py\x00tests/new.py\x00"
            raise AssertionError(f"unexpected sh args: {args}")

        env = self.base_env(GITHUB_EVENT_NAME="push",
                            GITHUB_EVENT_PATH=str(self.root / "event.json"))
        with mock.patch.object(rs, "MAP_PATH", str(self.root / "map.json")):
            text = self.run_main(env, sh=fake_sh)
        self.assertIn("### What changed in this run (`aaa..bbb`)", text)
        self.assertIn("- `bbb` subject one", text)
        self.assertIn("| scripts/ci/run_summary.py | modified | "
                      "`unittest` |", text)
        self.assertIn("| tests/new.py | renamed | - |", text)
        self.assertIn("- docs/new.md", text)  # uncovered list

    def test_push_no_map_lists_plain(self):
        (self.root / "event.json").write_text(
            '{"before": "aaa", "after": "bbb"}', encoding="utf-8")

        def fake_sh(*args):
            if args[0] == "printf":
                return REAL_SH(*args)
            if args[:2] == ("git", "log"):
                return b""
            if args[:2] == ("git", "diff"):
                return b"D\x00gone.py\x00"
            raise AssertionError(f"unexpected sh args: {args}")

        env = self.base_env(GITHUB_EVENT_NAME="push",
                            GITHUB_EVENT_PATH=str(self.root / "event.json"))
        with mock.patch.object(rs, "MAP_PATH",
                               str(self.root / "missing.json")):
            text = self.run_main(env, sh=fake_sh)
        self.assertIn("(none)", text)  # empty log degrades to a marker
        self.assertIn("no coverage map in this repo", text)
        self.assertIn("- gone.py (deleted)", text)

    def test_diff_failure_degrades(self):
        (self.root / "event.json").write_text(
            '{"before": "aaa", "after": "bbb"}', encoding="utf-8")

        def fake_sh(*args):
            if args[0] == "printf":
                return REAL_SH(*args)
            raise subprocess.CalledProcessError(128, list(args))

        env = self.base_env(GITHUB_EVENT_NAME="push",
                            GITHUB_EVENT_PATH=str(self.root / "event.json"))
        text = self.run_main(env, sh=fake_sh)
        self.assertIn("Diff unavailable in this checkout", text)

    def test_every_change_mapped_note(self):
        (self.root / "event.json").write_text(
            '{"before": "aaa", "after": "bbb"}', encoding="utf-8")
        (self.root / "map.json").write_text(
            '{"mappings": [{"pattern": "**", "checks": ["unittest"]}]}',
            encoding="utf-8")

        def fake_sh(*args):
            if args[0] == "printf":
                return REAL_SH(*args)
            if args[:2] == ("git", "log"):
                return b"bbb x"
            return b"M\x00anything.py\x00"

        env = self.base_env(GITHUB_EVENT_NAME="push",
                            GITHUB_EVENT_PATH=str(self.root / "event.json"))
        with mock.patch.object(rs, "MAP_PATH", str(self.root / "map.json")):
            text = self.run_main(env, sh=fake_sh)
        self.assertIn("Every changed file matches at least one coverage "
                      "mapping.", text)

    def test_self_test_failure_stops(self):
        with mock.patch.dict(os.environ, self.base_env(), clear=True), \
                mock.patch.object(rs, "_self_test",
                                  side_effect=AssertionError("broken")):
            with self.assertRaises(SystemExit):
                rs.main()
        self.assertFalse(self.summary.exists())

    def test_stdout_when_no_summary_env(self):
        env = self.base_env()
        del env["GITHUB_STEP_SUMMARY"]
        import contextlib
        import io
        buf = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(rs, "job_durations", return_value={}), \
                contextlib.redirect_stdout(buf):
            rs.main()
        self.assertIn("## Run summary - Tests", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
