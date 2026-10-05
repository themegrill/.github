// Pure parsers for the investigation event: no I/O, so they're unit-testable.

const ISSUE_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/;

// The Stage 2 prompt (prompts/crisp-triage-agent.md, step 5) mandates this note shape:
//   Investigation report: <summary>
//   - Bug: Filed: <url> | Already tracked: <url>
//   - Feature request: Filed: <url> | Already tracked: <url>
// Only the bullet lines are read -- the free-text summary is deliberately
// ignored so no model-written (customer-derived) text reaches the event log.
// "Already tracked" covers both a comment on a matching issue and an issue that
// already cites this conversation; the note can't tell those two apart.
//
// Newer notes also carry a "- Category: <value>" bullet and a trailing
// "=== DRAFT REPLY ... ===" block (customer-facing draft for staff). Everything
// from the draft marker on is cut off before any parsing: it is free text the
// model wrote for the customer, so it must never be mistaken for bullet lines
// or reach the event log.
const DRAFT_START = /^[ \t]*={2,}[ \t]*DRAFT REPLY\b.*$/im;

export function stripDraft(text) {
  const s = String(text ?? "");
  const m = DRAFT_START.exec(s);
  return m ? s.slice(0, m.index) : s;
}

export const CATEGORIES = ["product_bug", "conflict", "host", "user_error"];

// "plugin_bug" was this category's first name, before it was clear most repos
// here are themes. Still accepted so notes/events written under it parse.
const LEGACY_CATEGORY = { plugin_bug: "product_bug" };

// Returns one of CATEGORIES, "undetermined" (agent said evidence was
// insufficient), "not_applicable" (feature-request-only), or "unknown" (older
// note with no Category line, or an unrecognized value). Never throws.
export function parseCategory(text) {
  const m = stripDraft(text).match(/^\s*[-*]\s*Category\s*:\s*(.*)$/im);
  if (!m) return "unknown";
  const v = m[1].toLowerCase().replace(/[`*]/g, "");
  const known = CATEGORIES.find((c) => new RegExp(`\\b${c}\\b`).test(v));
  if (known) return known;
  if (/\bplugin_bug\b/.test(v)) return LEGACY_CATEGORY.plugin_bug;
  if (/\bplugin_bug\b/.test(v)) return LEGACY_CATEGORY.plugin_bug;
  if (/undetermined|insufficient/.test(v)) return "undetermined";
  if (/not[_ ]applicable|n\/a|feature/.test(v)) return "not_applicable";
  return "unknown";
}

export function parseNote(text) {
  const items = [];
  for (const line of stripDraft(text).split("\n")) {
    const m = line.match(/^\s*[-*]\s*(Bug|Feature request)\s*:\s*(.*)$/i);
    if (!m) continue;
    const kind = m[1].toLowerCase().startsWith("bug") ? "bug" : "feature";
    const rest = m[2];
    const result = /filed/i.test(rest) ? "filed" : /already tracked|tracked/i.test(rest) ? "tracked" : null;
    const url = rest.match(ISSUE_URL);
    if (!result || !url) continue;
    items.push({ kind, result, ref: `${url[1]}#${url[2]}`, url: url[0] });
  }
  const outcome = items.some((i) => i.result === "filed") ? "filed" : items.length ? "tracked" : "no_defect";
  return { items, outcome };
}

// opencode's `--format json` stream: one JSON event per line. Cost is read the
// same way summarize-investigation.mjs does (step_finish.part.cost); token
// counts are read from step_finish.part.tokens and come back null when the
// field is absent rather than failing the event.
export function parseOpencodeOutput(raw) {
  let cost = 0;
  let sawCost = false;
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  let sawTokens = false;
  let steps = 0;
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "step_finish") continue;
    steps++;
    const part = event.part ?? {};
    if (typeof part.cost === "number") {
      cost += part.cost;
      sawCost = true;
    }
    const t = part.tokens;
    if (t && typeof t === "object") {
      sawTokens = true;
      tokens.input += Number(t.input) || 0;
      tokens.output += Number(t.output) || 0;
      tokens.reasoning += Number(t.reasoning) || 0;
      tokens.cache_read += Number(t.cache?.read) || 0;
      tokens.cache_write += Number(t.cache?.write) || 0;
    }
  }
  return { steps, cost_usd: sawCost ? cost : null, tokens: sawTokens ? tokens : null };
}
