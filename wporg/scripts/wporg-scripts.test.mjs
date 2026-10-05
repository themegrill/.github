import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "wporg-"));
const w = (name, text) => { const p = join(tmp, name); writeFileSync(p, text); return p; };

test("build-prompt fills placeholders and does not expand them inside the topic", () => {
  const tpl = w("t.md", "<!-- c -->\ncode {{REPO}} issues {{ISSUE_REPO}} url {{CONVERSATION_URL}}\nBEGIN\n{{TRANSCRIPT}}\nEND");
  const tr = w("tr.txt", "evil {{ISSUE_REPO}} $& {{REPO}}");
  const out = execFileSync("node", [join(dir, "wporg-build-prompt.mjs"), tpl, "a/free", "a/pro", "bug", "slug", "https://x/", tr]).toString();
  assert.match(out, /^code a\/free issues a\/pro url https:\/\/x\//);
  assert.match(out, /evil \{\{ISSUE_REPO\}\} \$& \{\{REPO\}\}/);
  assert.doesNotMatch(out, /<!--/);
});

const check = (events) =>
  spawnSync("node", [join(dir, "wporg-check-done.mjs"), w("o.json", events.map((e) => JSON.stringify(e)).join("\n"))]);

test("check-done passes only on a real tool call, not on prose mentioning the script", () => {
  const prose = { type: "text", part: { text: "I will run wporg-done.mjs next" } };
  assert.equal(check([prose]).status, 1);
  const call = { type: "tool_use", part: { tool: "bash", state: { input: { command: "node $HOME/tg-autopilot/wporg-done.mjs u @r" }, output: "REPORT" } } };
  const r = check([prose, call]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString().trim(), "REPORT");
});
