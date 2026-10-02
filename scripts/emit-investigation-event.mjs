#!/usr/bin/env node
// Runs as the last step of each Stage 2 job (if: always()) and writes one
// `investigation` event. Deliberately a separate step, outside the agent's
// environment: the token that writes to the private events repo must never be
// visible to the LLM agent (it reads customer transcripts, so it can be
// prompt-injected). The agent only leaves harmless files behind -- opencode's
// output stream and a copy of the note crisp-post-note.mjs sent.
//
// Usage: emit-investigation-event.mjs <opencode-output.json> <last-note.txt>
// Env:   SESSION_ID REPO KIND ACCOUNT STARTED_AT(epoch s) AGENT_STEP_OUTCOME MODEL
import { readFile } from "node:fs/promises";
import { emitEvent } from "./events.mjs";
import { parseNote, parseOpencodeOutput } from "./events-parse.mjs";

const [outputPath, notePath] = process.argv.slice(2);
const { SESSION_ID, REPO, KIND, ACCOUNT, STARTED_AT, AGENT_STEP_OUTCOME, MODEL } = process.env;

const read = (path) => readFile(path, "utf8").catch(() => null);

async function main() {
  const [raw, note] = await Promise.all([read(outputPath), read(notePath)]);
  const agent = parseOpencodeOutput(raw);
  const parsed = note === null ? null : parseNote(note);

  const nowMs = Date.now();
  const startedMs = STARTED_AT ? Number(STARTED_AT) * 1000 : null;

  // The workflow already treats "agent never called crisp-post-note.mjs" as a
  // failure; mirror that so the dashboard and the red job agree.
  let status = "success";
  let reason = null;
  if (AGENT_STEP_OUTCOME === "cancelled") {
    // A cancelled run also leaves no note; say so instead of blaming the agent.
    status = "failed";
    reason = "cancelled";
  } else if (note === null) {
    status = "failed";
    reason = "no_note";
  } else if (AGENT_STEP_OUTCOME && AGENT_STEP_OUTCOME !== "success") {
    status = "failed";
    reason = "agent_step_failed";
  }

  await emitEvent("investigation", {
    session_id: SESSION_ID,
    account: ACCOUNT,
    repo: REPO,
    kind: KIND,
    status,
    reason,
    outcome: status === "failed" ? "failed" : parsed.outcome,
    items: parsed ? parsed.items : [],
    started_at: startedMs ? new Date(startedMs).toISOString() : null,
    duration_s: startedMs ? Math.round((nowMs - startedMs) / 1000) : null,
    agent: { model: MODEL ?? null, steps: agent.steps, cost_usd: agent.cost_usd, tokens: agent.tokens },
  });
}

// emitEvent never throws; this guards the parsing above. Exit 0 regardless --
// observability must not turn a good run red.
main().catch((err) => console.warn(`::warning::[events] investigation event failed: ${err.message}`));
