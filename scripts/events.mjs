// Best-effort event log for the triage dashboard.
//
// Each event is one small JSON file committed to a PRIVATE data repo through
// the Contents API (EVENTS_REPO), never to this public repo: events carry
// session ids, outcomes, issue links and costs, none of which belong in public.
// Distinct file per event means parallel jobs never touch the same path, so
// there is no git merge to resolve -- only the occasional 409 when two commits
// land on the branch at once, which is retried below.
//
// This must NEVER break the pipeline it observes: every failure is logged as a
// warning and swallowed, and with EVENTS_REPO / EVENTS_TOKEN unset it is a
// silent no-op (so this code can merge before the data repo exists).
//
// No customer text goes in an event -- no transcript, no summary, no issue
// title. Ids, enums, links, counts and costs only.
//
// Event types (all carry v, type, ts, run_id, run_attempt, run_url, workflow):
//   scan           one per classify run: totals + one entry per conversation
//                  that reached the classifier (path, verdict, classifier cost)
//   investigation  one per Stage 2 job: status, outcome, items filed/tracked,
//                  agent cost and tokens, duration
import { randomBytes } from "node:crypto";

export const SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 4;

function warn(msg) {
  console.warn(`::warning::[events] ${msg}`);
}

export function eventPath(type, key, now = new Date(), rand = randomBytes(2).toString("hex")) {
  const iso = now.toISOString(); // 2026-10-02T09:12:03.456Z
  const [date, time] = iso.split("T");
  const [y, m, d] = date.split("-");
  const hms = time.slice(0, 8).replaceAll(":", "");
  const safeKey = String(key ?? "run").replace(/^session_/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "run";
  return `events/${y}/${m}/${d}/${hms}-${type}-${safeKey}-${rand}.json`;
}

export function buildEvent(type, data, env = process.env, now = new Date()) {
  const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = env;
  return {
    v: SCHEMA_VERSION,
    type,
    ts: now.toISOString(),
    run_id: GITHUB_RUN_ID ?? null,
    run_attempt: GITHUB_RUN_ATTEMPT ? Number(GITHUB_RUN_ATTEMPT) : null,
    run_url:
      GITHUB_RUN_ID && GITHUB_REPOSITORY
        ? `${GITHUB_SERVER_URL ?? "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : null,
    workflow: GITHUB_WORKFLOW ?? null,
    ...data,
  };
}

// Returns { ok, path?, skipped?, error? }. Never throws.
export async function emitEvent(type, data = {}, { env = process.env, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = new Date() } = {}) {
  const { EVENTS_REPO, EVENTS_TOKEN, EVENTS_BRANCH } = env;
  if (!EVENTS_REPO || !EVENTS_TOKEN) return { ok: false, skipped: true };

  try {
    const event = buildEvent(type, data, env, now);
    const path = eventPath(type, data.session_id ?? env.GITHUB_RUN_ID, now);
    const body = JSON.stringify({
      message: `event: ${type}${data.session_id ? ` ${data.session_id}` : ""} [skip ci]`,
      content: Buffer.from(JSON.stringify(event) + "\n").toString("base64"),
      branch: EVENTS_BRANCH || "main",
    });

    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetchImpl(`https://api.github.com/repos/${EVENTS_REPO}/contents/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${EVENTS_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body,
      });
      if (res.ok) return { ok: true, path };
      lastError = `${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`;
      // 409: another commit moved the branch; 429/403-with-retry and 5xx: transient.
      const retryable = res.status === 409 || res.status === 429 || res.status >= 500 || (res.status === 403 && res.headers?.get?.("retry-after"));
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
    warn(`could not write ${type} event to ${EVENTS_REPO}: ${lastError}`);
    return { ok: false, error: lastError };
  } catch (err) {
    warn(`could not write ${type} event: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
