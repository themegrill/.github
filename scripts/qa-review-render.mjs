// Turns the model's JSON into the PR comment. The model is untrusted (its input
// includes attacker-controllable PR text), so nothing it says is shown unless
// it survives validation, and everything shown is sanitized.
//
// Rule from CHANGELOG 2026-10-05: self-reported confidence is not calibrated
// and a confidently wrong diagnosis is the known failure mode. So there is no
// confidence number, and a claim is only shown when it can be checked against
// the diff (risks) or against the real test-case index (manual tests).

const ZWSP = "\u200b";

// Plain text only: no links, no mentions, no HTML, no code fences, one line.
export function sanitize(value, max = 300) {
  let s = typeof value === "string" ? value : "";
  s = s
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // control chars incl. newlines: keeps it to one line
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\bwww\.\S+/gi, "[link removed]")
    .replace(/[<>]/g, "") // no HTML or comment markers (so no forged <!-- marker -->)
    .replace(/`+/g, "'") // can't break out of our own code spans
    .replace(/@/g, `@${ZWSP}`) // no mentions; also defuses trigger phrases like "@tg-autopilot review"
    .replace(/[|]/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// ctx: { addedByFile: {file: Set<line>}, titles: [{title,file}] }
export function validateReview(raw, ctx) {
  const data = raw && typeof raw === "object" ? raw : {};
  const known = new Map(ctx.titles.map((t) => [t.title.trim(), t]));
  const dropped = { risks: 0, manual_tests: 0, new_scenarios: 0 };

  const risks = [];
  for (const r of asArray(data.risks)) {
    const line = Number(r?.line);
    const lines = ctx.addedByFile[r?.file];
    if (!lines || !Number.isInteger(line) || !lines.has(line) || !sanitize(r.claim)) {
      dropped.risks++;
      continue;
    }
    if (risks.length < 8) risks.push({ file: r.file, line, claim: sanitize(r.claim), evidence: sanitize(r.evidence) });
  }

  const manual = [];
  const seen = new Set();
  for (const t of asArray(data.manual_tests)) {
    const key = typeof t?.title === "string" ? t.title.trim() : "";
    if (!known.has(key) || seen.has(key)) {
      dropped.manual_tests++;
      continue;
    }
    seen.add(key);
    if (manual.length < 8) manual.push({ title: key, file: known.get(key).file, why: sanitize(t.why) });
  }

  const scenarios = [];
  for (const s of asArray(data.new_scenarios)) {
    if (!sanitize(s?.scenario)) {
      dropped.new_scenarios++;
      continue;
    }
    if (scenarios.length < 5) scenarios.push({ scenario: sanitize(s.scenario), why: sanitize(s.why) });
  }

  return { summary: sanitize(data.summary, 700), risks, manual, scenarios, dropped };
}

const STATE_ICON = { success: "✅", failure: "❌", cancelled: "⚪", skipped: "⚪", neutral: "⚪", timed_out: "❌", action_required: "⚠️" };

// facts: deterministic data (never from the model).
export function renderComment({ review, facts }) {
  const { headSha, areas, unmapped, checks, shown, omitted, noPatch, testsTouched, qaDataPresent, usage, model } = facts;
  const L = [];
  L.push(`## QA review for \`${headSha.slice(0, 7)}\``);
  L.push("");
  L.push(
    "_Advisory, AI-assisted. It reads the diff and this repo's QA notes; it does not run the code. Specific findings below were checked against the diff, but a clean result is not a guarantee._"
  );
  L.push("");
  L.push(`**Summary:** ${review.summary || "_No summary produced._"}`);
  L.push("");

  const areaNames = Object.keys(areas);
  if (areaNames.length) {
    L.push("**Areas touched** (from `.themegrill-qa/suite.json`): " + areaNames.map((a) => `\`${a}\` (${areas[a].length})`).join(", "));
  } else if (qaDataPresent) {
    L.push("**Areas touched:** none of the changed files match a known QA area.");
  } else {
    L.push("**Areas touched:** unknown. This repo has no `.themegrill-qa/` data, so no test-case suggestions are possible.");
  }
  if (unmapped.length && areaNames.length) L.push(`${unmapped.length} changed file(s) are not mapped to any area.`);
  if (testsTouched.length) L.push(`This PR also changes ${testsTouched.length} test file(s), so some coverage may be new.`);
  L.push("");

  if (checks.length) {
    L.push("**Other checks on this commit:** " + checks.map((c) => `${STATE_ICON[c.state] ?? "⏳"} ${sanitize(c.name, 60)}`).join(" · "));
    L.push("");
  }

  L.push("### Possible risks in the changed lines");
  if (review.risks.length) {
    for (const r of review.risks) L.push(`- \`${sanitize(r.file, 200)}:${r.line}\`: ${r.claim}${r.evidence ? ` _(${r.evidence})_` : ""}`);
  } else {
    L.push("_None found that could be tied to a specific changed line._");
  }
  L.push("");

  L.push("### Existing test cases worth running by hand");
  if (review.manual.length) {
    for (const t of review.manual) L.push(`- **${sanitize(t.title, 200)}** (\`${sanitize(t.file, 80)}\`): ${t.why}`);
  } else {
    L.push("_No existing test case clearly applies._");
  }
  L.push("");

  if (review.scenarios.length) {
    L.push("### Scenarios with no existing test case");
    for (const s of review.scenarios) L.push(`- ${s.scenario}${s.why ? ` _(${s.why})_` : ""}`);
    L.push("");
  }

  const notes = [];
  notes.push(`Reviewed ${shown.length} file(s)`);
  if (omitted.length) notes.push(`${omitted.length} not shown to the model (size limit): ${omitted.slice(0, 5).map((f) => `\`${sanitize(f, 80)}\``).join(", ")}${omitted.length > 5 ? ", …" : ""}`);
  if (noPatch.length) notes.push(`${noPatch.length} had no readable diff (binary or too large)`);
  const droppedN = review.dropped.risks + review.dropped.manual_tests + review.dropped.new_scenarios;
  if (droppedN) notes.push(`${droppedN} model suggestion(s) discarded because they could not be verified`);
  const cost = usage?.cost_usd != null ? `, ~$${usage.cost_usd.toFixed(3)}` : "";
  const tokens = usage?.input_tokens != null ? `, ${usage.input_tokens} in / ${usage.output_tokens} out tokens` : "";
  L.push(`<sub>${notes.join(". ")}. Model: ${sanitize(String(model), 60)}${tokens}${cost}.</sub>`);
  return L.join("\n");
}
