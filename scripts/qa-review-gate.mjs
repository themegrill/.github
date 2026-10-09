// QA review gate: the AUTHORITATIVE check that a review request is allowed to
// run. n8n pre-filters too, but its payload is untrusted (anyone who finds the
// webhook URL can POST to it, and manual workflow_dispatch skips n8n entirely),
// so everything is re-verified here against the live GitHub API.
//
// Two outcomes, deliberately different:
//   - DENIED (allowed=false): a legitimate "no" (draft, stale SHA, no write
//     access...). Exit 0 so later steps can report it; the job stays green.
//   - ERROR (thrown): the token can't read the repo/PR, wrong identity, etc.
//     Exit 1. A silently-green job that did nothing is exactly the failure mode
//     the 2026-10-05 wp.org CHANGELOG entry describes.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghTokenForRepo } from "./github-client.mjs";

export const BOT_LOGIN = "tg-autopilot";

// Same ranking as copilot-review-on-comment.yml. Each review spends LLM money,
// so triage-level users (who GitHub lets request reviewers) are NOT enough.
const RANK = { admin: 4, maintain: 3, write: 2, triage: 1 };
export const MIN_PERMISSION = "write";

// repo/pr arrive from a dispatch payload: validate strictly before they go
// anywhere near a URL, a filename or a log line.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_RE = /^[1-9][0-9]{0,8}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function validateInput({ repo, pr, requester, expectedSha }) {
  if (!REPO_RE.test(repo ?? "") || repo.split("/").some((p) => p === "." || p === "..")) {
    return "repo must look like owner/name"; // "../x" matches the regex but would traverse in API URLs
  }
  if (!PR_RE.test(String(pr ?? ""))) return "pr must be a positive integer";
  if (!USER_RE.test(requester ?? "")) return "requester is not a valid GitHub login";
  if (expectedSha && !SHA_RE.test(expectedSha)) return "head_sha must be a 40-char hex sha";
  return null;
}

export function isAllowlisted(config, repo) {
  const [owner, name] = repo.split("/");
  const list = config?.[owner];
  return Array.isArray(list) && list.includes(name);
}

export function hasMinPermission(permission, min = MIN_PERMISSION) {
  return (RANK[permission] ?? 0) >= RANK[min];
}

// Pure decision over already-fetched facts, so every rule is unit-testable.
export function decide({ pr, permission, requester, expectedSha }) {
  if (requester.toLowerCase() === BOT_LOGIN) {
    return deny("self", "Request was made by the bot itself; ignoring to avoid a loop.");
  }
  if (pr.state !== "open") return deny("not-open", `PR is ${pr.state}.`);
  if (pr.draft) return deny("draft", "PR is a draft.");
  if (!pr.head?.repo || pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()) {
    // Fork (or deleted fork): later phases run PR-influenced tooling, so only
    // same-repo branches are in scope until a maintainer-approval flow exists.
    return deny("fork", "PRs from forks are not supported yet.");
  }
  if (expectedSha && expectedSha !== pr.head.sha) {
    return deny("stale", `PR head moved (requested ${expectedSha.slice(0, 7)}, now ${pr.head.sha.slice(0, 7)}). Re-request the review.`);
  }
  if (!hasMinPermission(permission)) {
    return deny("permission", `@${requester} needs write access (or higher) to request a QA review.`, true);
  }
  return { allowed: true, code: "ok", reason: "ok", headSha: pr.head.sha, baseRef: pr.base.ref };
}

function deny(code, reason, notify = false) {
  return { allowed: false, code, reason, notify };
}

export async function runGate({ repo, pr, requester, expectedSha, config, api }) {
  const bad = validateInput({ repo, pr, requester, expectedSha });
  if (bad) return deny("bad-input", bad);
  if (!isAllowlisted(config, repo)) return deny("not-allowlisted", `${repo} is not enrolled in QA review.`);

  const bot = await api.whoami();
  if (bot.toLowerCase() !== BOT_LOGIN) {
    throw new Error(`Token for ${repo} authenticates as "${bot}", expected "${BOT_LOGIN}". Wrong secret for this org?`);
  }
  const prData = await api.getPr(repo, pr);
  const permission = await api.getPermission(repo, requester);
  return decide({ pr: prData, permission, requester, expectedSha });
}

export function makeApi(token, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const get = async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { headers });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    whoami: async () => (await get("/user")).login,
    getPr: (repo, n) => get(`/repos/${repo}/pulls/${n}`),
    // Not-a-collaborator comes back as 404/200-with-"none" depending on the
    // account; both must read as "no access", not as an infrastructure error.
    getPermission: async (repo, user) => {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/collaborators/${user}/permission`, { headers });
      if (res.status === 404) return "none";
      if (!res.ok) throw new Error(`GitHub permission lookup failed: ${res.status} ${await res.text()}`);
      return (await res.json()).permission;
    },
  };
}

async function main() {
  const { QA_REPO, QA_PR, QA_REQUESTER, QA_HEAD_SHA, GITHUB_OUTPUT } = process.env;
  const config = JSON.parse(readFileSync(new URL("../config/qa-review-repos.json", import.meta.url), "utf8"));
  // Validate before choosing a token: ghTokenForRepo() needs a sane repo string.
  const early = validateInput({ repo: QA_REPO, pr: QA_PR, requester: QA_REQUESTER, expectedSha: QA_HEAD_SHA });
  const token = early ? undefined : ghTokenForRepo(QA_REPO);
  if (!early && !token) throw new Error(`No bot token configured for ${QA_REPO}'s org`);

  const result = await runGate({
    repo: QA_REPO,
    pr: QA_PR,
    requester: QA_REQUESTER,
    expectedSha: QA_HEAD_SHA || undefined,
    config,
    api: token ? makeApi(token) : null,
  });

  console.log(JSON.stringify(result));
  if (GITHUB_OUTPUT) {
    const lines = [
      `allowed=${result.allowed}`,
      `code=${result.code}`,
      // Reasons are built from validated fields only, but keep outputs single-line regardless.
      `reason=${String(result.reason).replace(/[\r\n]+/g, " ")}`,
      `notify=${Boolean(result.notify)}`,
      `head_sha=${result.headSha ?? ""}`,
    ];
    appendFileSync(GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
