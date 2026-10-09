import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInput, isAllowlisted, hasMinPermission, decide, runGate, BOT_LOGIN } from "./qa-review-gate.mjs";
import { findSticky, withMarker, upsertSticky, MARKER } from "./qa-review-comment.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const CONFIG = { themegrill: ["user-registration-pro"], wpeverest: [] };
const basePr = (over = {}) => ({
  state: "open",
  draft: false,
  head: { sha: SHA, repo: { full_name: "themegrill/user-registration-pro" } },
  base: { ref: "develop", repo: { full_name: "themegrill/user-registration-pro" } },
  ...over,
});
const api = ({ pr = basePr(), permission = "write", login = BOT_LOGIN } = {}) => ({
  whoami: async () => login,
  getPr: async () => pr,
  getPermission: async () => permission,
});
const gate = (over = {}, apiOver = {}) =>
  runGate({ repo: "themegrill/user-registration-pro", pr: "12", requester: "alice", config: CONFIG, api: api(apiOver), ...over });

test("validateInput rejects injection-shaped values", () => {
  const ok = { repo: "o/r", pr: "1", requester: "alice" };
  assert.equal(validateInput(ok), null);
  assert.ok(validateInput({ ...ok, repo: "o/r; rm -rf /" }));
  assert.ok(validateInput({ ...ok, repo: "../../x" }));
  assert.ok(validateInput({ ...ok, repo: "../x" })); // regex-legal but path traversal in API URLs
  assert.ok(validateInput({ ...ok, repo: "o/.." }));
  assert.ok(validateInput({ ...ok, repo: "o/r/extra" }));
  assert.ok(validateInput({ ...ok, pr: "0" }));
  assert.ok(validateInput({ ...ok, pr: "1 2" }));
  assert.ok(validateInput({ ...ok, requester: "a b" }));
  assert.ok(validateInput({ ...ok, requester: "$(id)" }));
  assert.ok(validateInput({ ...ok, expectedSha: "abc" }));
});

test("allowlist is per-org and exact", () => {
  assert.equal(isAllowlisted(CONFIG, "themegrill/user-registration-pro"), true);
  assert.equal(isAllowlisted(CONFIG, "themegrill/user-registration"), false);
  assert.equal(isAllowlisted(CONFIG, "wpeverest/user-registration-pro"), false);
  assert.equal(isAllowlisted(CONFIG, "other/user-registration-pro"), false);
});

test("permission ranking: triage and read are not enough", () => {
  for (const p of ["admin", "maintain", "write"]) assert.equal(hasMinPermission(p), true, p);
  for (const p of ["triage", "read", "none", undefined]) assert.equal(hasMinPermission(p), false, String(p));
});

test("happy path returns head sha and base ref", async () => {
  const r = await gate({ expectedSha: SHA });
  assert.equal(r.allowed, true);
  assert.equal(r.headSha, SHA);
  assert.equal(r.baseRef, "develop");
});

test("denials: code and whether the requester is notified", async () => {
  assert.deepEqual(pick(await gate({}, { permission: "triage" })), { code: "permission", notify: true });
  assert.deepEqual(pick(await gate({}, { pr: basePr({ draft: true }) })), { code: "draft", notify: false });
  assert.deepEqual(pick(await gate({}, { pr: basePr({ state: "closed" }) })), { code: "not-open", notify: false });
  assert.deepEqual(pick(await gate({ expectedSha: OTHER })), { code: "stale", notify: false });
  assert.deepEqual(pick(await gate({ requester: BOT_LOGIN })), { code: "self", notify: false });
  assert.deepEqual(pick(await gate({ repo: "themegrill/other" })), { code: "not-allowlisted", notify: false });
  assert.deepEqual(pick(await gate({ pr: "x" })), { code: "bad-input", notify: false });
});

test("fork PRs (and deleted forks) are denied", async () => {
  const fork = basePr({ head: { sha: SHA, repo: { full_name: "mallory/user-registration-pro" } } });
  assert.equal((await gate({}, { pr: fork })).code, "fork");
  const deleted = basePr({ head: { sha: SHA, repo: null } });
  assert.equal((await gate({}, { pr: deleted })).code, "fork");
});

test("wrong token identity is an ERROR, not a denial", async () => {
  await assert.rejects(gate({}, { login: "lihsaa591" }), /expected "tg-autopilot"/);
});

test("decide never trusts the bot's own request even with write access", () => {
  assert.equal(decide({ pr: basePr(), permission: "admin", requester: "TG-Autopilot" }).code, "self");
});

test("sticky comment: matched by login AND marker, never by marker alone", () => {
  const mine = { id: 1, user: { login: BOT_LOGIN }, body: `${MARKER}\nhi` };
  const spoof = { id: 2, user: { login: "mallory" }, body: `${MARKER}\nfake` };
  const unrelated = { id: 3, user: { login: BOT_LOGIN }, body: "Build ZIP ready" };
  assert.equal(findSticky([spoof, unrelated, mine]).id, 1);
  assert.equal(findSticky([spoof, unrelated]), undefined);
  assert.ok(withMarker("x").startsWith(MARKER));
});

test("upsertSticky: creates when absent, PATCHes the existing one when present", async () => {
  const calls = [];
  const mk = (existing) => async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const json = init.method ? { html_url: "u" } : existing ? [{ id: 9, user: { login: BOT_LOGIN }, body: MARKER }] : [];
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  };
  const created = await upsertSticky({ repo: "o/r", pr: 1, body: "b", token: "t", fetchImpl: mk(false) });
  assert.equal(created.updated, false);
  assert.equal(calls.at(-1).method, "POST");
  const updated = await upsertSticky({ repo: "o/r", pr: 1, body: "b", token: "t", fetchImpl: mk(true) });
  assert.equal(updated.updated, true);
  assert.deepEqual(calls.at(-1), { url: "https://api.github.com/repos/o/r/issues/comments/9", method: "PATCH" });
});

function pick(r) {
  return { code: r.code, notify: r.notify };
}
