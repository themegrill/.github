import { test } from "node:test";
import assert from "node:assert/strict";
import { emitEvent, eventPath, buildEvent } from "./events.mjs";
import { parseNote, parseCategory, parseOpencodeOutput } from "./events-parse.mjs";
import { costUSD } from "./pricing.mjs";

const ENV = {
  EVENTS_REPO: "org/data",
  EVENTS_TOKEN: "tok",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "org/.github",
  GITHUB_WORKFLOW: "Crisp triage",
};
const NOW = new Date("2026-10-02T09:12:03.456Z");
const noSleep = async () => {};
const res = (status, text = "") => ({ ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: () => null } });

test("eventPath is date-partitioned and filesystem-safe", () => {
  // path separators and dots in a key can't escape the events/ tree
  assert.equal(
    eventPath("investigation", "session_6a8633-0827/../x", NOW, "ab12"),
    "events/2026/10/02/091203-investigation-6a8633-0827x-ab12.json"
  );
  assert.match(eventPath("scan", undefined, NOW, "ab12"), /^events\/2026\/10\/02\/091203-scan-run-ab12\.json$/);
});

test("buildEvent carries run metadata", () => {
  const e = buildEvent("scan", { totals: {} }, ENV, NOW);
  assert.equal(e.v, 1);
  assert.equal(e.run_url, "https://github.com/org/.github/actions/runs/123");
  assert.equal(e.ts, "2026-10-02T09:12:03.456Z");
});

test("emitEvent is a silent no-op when not configured", async () => {
  let called = false;
  const out = await emitEvent("scan", {}, { env: {}, fetchImpl: async () => { called = true; } });
  assert.deepEqual(out, { ok: false, skipped: true });
  assert.equal(called, false);
});

test("emitEvent PUTs base64 JSON to the contents API", async () => {
  let req;
  const out = await emitEvent("investigation", { session_id: "session_abc", outcome: "filed" }, {
    env: ENV, now: NOW, sleep: noSleep,
    fetchImpl: async (url, init) => { req = { url, init }; return res(201); },
  });
  assert.equal(out.ok, true);
  assert.match(req.url, /^https:\/\/api\.github\.com\/repos\/org\/data\/contents\/events\/2026\/10\/02\//);
  assert.equal(req.init.method, "PUT");
  assert.equal(req.init.headers.Authorization, "Bearer tok");
  const body = JSON.parse(req.init.body);
  assert.equal(body.branch, "main");
  const event = JSON.parse(Buffer.from(body.content, "base64").toString());
  assert.equal(event.session_id, "session_abc");
  assert.equal(event.outcome, "filed");
});

test("emitEvent retries a 409 then succeeds", async () => {
  const statuses = [409, 409, 201];
  const out = await emitEvent("scan", {}, { env: ENV, now: NOW, sleep: noSleep, fetchImpl: async () => res(statuses.shift()) });
  assert.equal(out.ok, true);
  assert.equal(statuses.length, 0);
});

test("emitEvent gives up quietly on a hard failure and never throws", async () => {
  let calls = 0;
  const out = await emitEvent("scan", {}, { env: ENV, now: NOW, sleep: noSleep, fetchImpl: async () => { calls++; return res(404, "Not Found"); } });
  assert.equal(out.ok, false);
  assert.equal(calls, 1); // 404 is not retryable
  const thrown = await emitEvent("scan", {}, { env: ENV, now: NOW, sleep: noSleep, fetchImpl: async () => { throw new Error("network down"); } });
  assert.equal(thrown.ok, false);
});

test("parseNote: filed bug + tracked feature", () => {
  const note = [
    "Investigation report: something customer specific that must not be copied",
    "",
    "- Bug: Filed: https://github.com/org/plugin/issues/12",
    "- Feature request: Already tracked: https://github.com/org/plugin-pro/issues/7",
  ].join("\n");
  const { items, outcome } = parseNote(note);
  assert.equal(outcome, "filed");
  assert.deepEqual(items, [
    { kind: "bug", result: "filed", ref: "org/plugin#12", url: "https://github.com/org/plugin/issues/12" },
    { kind: "feature", result: "tracked", ref: "org/plugin-pro#7", url: "https://github.com/org/plugin-pro/issues/7" },
  ]);
  assert.ok(!JSON.stringify(items).includes("customer specific"));
});

test("parseNote: markdown link and trailing punctuation", () => {
  const { items } = parseNote("- Bug: Already tracked: [#9](https://github.com/org/p/issues/9).");
  assert.equal(items[0].ref, "org/p#9");
});

test("parseNote: no bullets means no_defect", () => {
  assert.deepEqual(parseNote("Investigation report: client-side config problem."), { items: [], outcome: "no_defect" });
  assert.deepEqual(parseNote(""), { items: [], outcome: "no_defect" });
});

const DRAFT = [
  "=== DRAFT REPLY (for staff to edit and send -- the bot never messages the customer) ===",
  "- Bug: Filed: https://github.com/org/p/issues/1",
  "- Category: plugin_bug",
  "=== END DRAFT ===",
].join("\n");

test("parseCategory: new-format notes", () => {
  const bug = ["Investigation report: x", "", "- Category: plugin_bug", "- Evidence: a.php:3", "- Bug: Filed: https://github.com/org/p/issues/5", "", DRAFT].join("\n");
  assert.equal(parseCategory(bug), "plugin_bug");
  assert.deepEqual(parseNote(bug).items.map((i) => i.ref), ["org/p#5"]);
  const conflict = ["Investigation report: x", "- Category: `conflict`", "", DRAFT].join("\n");
  assert.equal(parseCategory(conflict), "conflict");
  assert.equal(parseNote(conflict).outcome, "no_defect"); // bullets inside the draft are ignored
  assert.equal(parseCategory("- Category: undetermined (need version)"), "undetermined");
  assert.equal(parseCategory("- Category: not_applicable"), "not_applicable");
});

test("parseCategory: old/garbled notes are unknown, never throw", () => {
  assert.equal(parseCategory("Investigation report: old\n- Bug: Filed: https://github.com/org/p/issues/5"), "unknown");
  assert.equal(parseCategory("- Category: weird"), "unknown");
  assert.equal(parseCategory(""), "unknown");
  assert.equal(parseCategory(null), "unknown");
  assert.equal(parseCategory(undefined), "unknown");
  // A Category line that only appears inside the draft does not count.
  assert.equal(parseCategory(`Investigation report: x\n${DRAFT}`), "unknown");
});

test("parseOpencodeOutput sums cost and tokens, tolerates junk and missing fields", () => {
  const raw = [
    JSON.stringify({ type: "step_start" }),
    "not json",
    JSON.stringify({ type: "step_finish", part: { cost: 0.01, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } } } }),
    JSON.stringify({ type: "step_finish", part: { cost: 0.02, tokens: { input: 200, output: 20 } } }),
  ].join("\n");
  const out = parseOpencodeOutput(raw);
  assert.equal(out.steps, 2);
  assert.ok(Math.abs(out.cost_usd - 0.03) < 1e-9);
  assert.deepEqual(out.tokens, { input: 300, output: 30, reasoning: 5, cache_read: 50, cache_write: 0 });
  assert.deepEqual(parseOpencodeOutput(null), { steps: 0, cost_usd: null, tokens: null });
});

test("costUSD: known model, prefix, unknown model", () => {
  assert.ok(Math.abs(costUSD("gpt-5-mini", 2399, 66) - 0.00073175) < 1e-9);
  assert.equal(costUSD("openai/gpt-5-mini", 1_000_000, 0), 0.25);
  assert.equal(costUSD("mystery-model", 1, 1), null);
  assert.equal(costUSD("gpt-5-mini", null, 5), null);
});
