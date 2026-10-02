import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, renderPage } from "./build-dashboard.mjs";

const scan = (run_id, conversations, extra = {}) => ({
  v: 1, type: "scan", ts: "2026-10-02T06:00:00Z", run_id, run_url: `https://x/runs/${run_id}`, trigger: "schedule",
  started_at: "2026-10-02T05:58:00Z", ended_at: "2026-10-02T05:59:00Z", conversations, ...extra,
});
const conv = (session_id, o = {}) => ({
  session_id, account: "A", path: "stale", repo: "org/p", kind: "bug", actionable: true, escalated: true, reason: null,
  classifier: { model: "m", input_tokens: 100, output_tokens: 10, cost_usd: 0.001 }, ...o,
});
const inv = (run_id, session_id, o = {}) => ({
  v: 1, type: "investigation", ts: "2026-10-02T06:05:00Z", run_id, session_id, account: "A", repo: "org/p", kind: "bug",
  status: "success", reason: null, outcome: "tracked", items: [{ kind: "bug", result: "tracked", ref: "org/p#1", url: "u" }],
  started_at: "2026-10-02T06:00:00Z", duration_s: 40, agent: { model: "m", steps: 3, cost_usd: 0.02, tokens: { input: 1, output: 1 } }, ...o,
});

test("pairs an escalated scan entry with its investigation and sums cost", () => {
  const rows = buildRows([scan("1", [conv("s1")]), inv("1", "s1")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "tracked");
  assert.equal(rows[0].duration_s, 40);
  assert.ok(Math.abs(rows[0].cost - 0.021) < 1e-9);
});

test("classifier-rejected entries are skipped rows, with the reason", () => {
  const rows = buildRows([scan("1", [conv("s1", { escalated: false, actionable: false, reason: "not_actionable" })])]);
  assert.equal(rows[0].outcome, "skipped");
  assert.equal(rows[0].reason, "not_actionable");
});

test("escalated with no investigation event is 'unrecorded', not dropped", () => {
  const rows = buildRows([scan("1", [conv("s1")])]);
  assert.equal(rows[0].outcome, "unrecorded");
});

test("an investigation from another run is not paired", () => {
  const rows = buildRows([scan("1", [conv("s1")]), inv("2", "s1")]);
  assert.deepEqual(rows.map((r) => r.outcome).sort(), ["tracked", "unrecorded"]);
});

test("orphan investigation (no scan) still appears", () => {
  const rows = buildRows([inv("9", "s9", { outcome: "failed", reason: "cancelled" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "cancelled");
});

test("a session claimed twice in one scan yields one row; a re-run attempt replaces its investigation", () => {
  const rows = buildRows([
    scan("1", [conv("s1"), conv("s1")]),
    inv("1", "s1", { outcome: "failed", reason: "no_note", ts: "2026-10-02T06:05:00Z" }),
    inv("1", "s1", { outcome: "filed", ts: "2026-10-02T07:05:00Z" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "filed");
});

test("renderPage embeds data and cannot break out of the script tag", () => {
  const out = renderPage("<script>const D = /*__DATA__*/null;</script>", { rows: [{ x: "</script><b>" }] });
  assert.ok(!out.slice(8).includes("</script><b>"));
  assert.match(out, /\\u003c\/script>/);
});
