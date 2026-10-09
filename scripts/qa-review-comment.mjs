// Creates or updates THE single QA-review comment on a PR (never one per run).
//
// Identity rule (write-safe-bot-workflow skill): the machine user's API type is
// "User", not "Bot", so our own comment is recognised by login + a stable body
// marker, never by user.type.
//
// Loop safety: nothing here can re-trigger anything. The only trigger for QA
// review is a review_requested event, never a comment, so the text below is
// free to say whatever it needs to.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghTokenForRepo } from "./github-client.mjs";
import { BOT_LOGIN } from "./qa-review-gate.mjs";

export const MARKER = "<!-- tg-autopilot:qa-review -->";
const MAX_BODY = 60000; // GitHub's hard limit is 65536 chars

export function withMarker(body) {
  const trimmed = body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n\n_(truncated)_" : body;
  return `${MARKER}\n${trimmed}`;
}

export function findSticky(comments) {
  // Newest-first would be wrong if an old duplicate exists; take the first
  // (oldest) so repeated runs converge on one comment.
  return comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.startsWith(MARKER));
}

export async function upsertSticky({ repo, pr, body, token, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const base = `https://api.github.com/repos/${repo}/issues`;

  let existing;
  for (let page = 1; page <= 10 && !existing; page++) {
    const res = await fetchImpl(`${base}/${pr}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`List comments failed on ${repo}#${pr}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    existing = findSticky(batch);
    if (batch.length < 100) break;
  }

  const payload = JSON.stringify({ body: withMarker(body) });
  const res = existing
    ? await fetchImpl(`${base}/comments/${existing.id}`, { method: "PATCH", headers, body: payload })
    : await fetchImpl(`${base}/${pr}/comments`, { method: "POST", headers, body: payload });
  if (!res.ok) throw new Error(`Upsert comment failed on ${repo}#${pr}: ${res.status} ${await res.text()}`);
  return { updated: Boolean(existing), url: (await res.json()).html_url };
}

async function main() {
  const [repo, pr, bodyFile] = process.argv.slice(2);
  if (!repo || !pr || !bodyFile) throw new Error("usage: qa-review-comment.mjs <owner/repo> <pr> <body-file>");
  const token = ghTokenForRepo(repo);
  if (!token) throw new Error(`No bot token configured for ${repo}'s org`);
  const out = await upsertSticky({ repo, pr, body: readFileSync(bodyFile, "utf8"), token });
  console.log(`${out.updated ? "Updated" : "Created"} QA review comment: ${out.url}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
