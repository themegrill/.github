// QA review runner: gather (read-only) -> ONE model call -> validate -> render.
// Never checks out or executes PR code. Writes the comment body to a file; the
// workflow decides whether to post it. Run only AFTER qa-review-gate.mjs allowed it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghTokenForRepo } from "./github-client.mjs";
import { chatJSONWithUsage } from "./openai-client.mjs";
import { buildDiff, isTestFile, loadQaData, makeReader, mapAreas } from "./qa-review-context.mjs";
import { limitsFor, renderComment, validateReview } from "./qa-review-render.mjs";

const TAGS = "pr_title|pr_body|diff|knowledge|existing_test_cases|other_checks|areas_touched";

// Untrusted text must not be able to close one of our data blocks early.
export function escapeTags(s) {
  return String(s ?? "").replace(new RegExp(`</(${TAGS})>`, "gi"), "<\\/$1>");
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "\n[truncated]" : s);

export function buildUserMessage({ pr, areas, checks, qa, diff }) {
  const cases = qa.titles.map((t) => `- ${t.title}`).join("\n");
  return [
    `<pr_title>${escapeTags(pr.title)}</pr_title>`,
    `<pr_body>${escapeTags(clip(pr.body ?? "", 3000))}</pr_body>`,
    `<areas_touched>${escapeTags(JSON.stringify(Object.fromEntries(Object.entries(areas).map(([a, f]) => [a, f.length]))))}</areas_touched>`,
    `<other_checks>${escapeTags((checks ?? []).map((c) => `${c.name}: ${c.state}`).join("\n") || "(not available)")}</other_checks>`,
    `<knowledge>${escapeTags(clip(qa.knowledge, 12000))}</knowledge>`,
    `<existing_test_cases>\n${escapeTags(cases)}\n</existing_test_cases>`,
    `<diff>\n${escapeTags(diff.text)}\n</diff>`,
  ].join("\n\n");
}

export async function runReview({ repo, prNumber, expectedSha, reader, chat, systemPrompt, maxDiffChars = 60000 }) {
  const pr = await reader.getPr(repo, prNumber);
  if (pr.head.sha !== expectedSha) {
    // The gate passed for a different commit. Reviewing newer code under the old
    // SHA's name would be wrong; the requester can simply re-request.
    throw new Error(`PR head moved since the gate ran (${expectedSha.slice(0, 7)} -> ${pr.head.sha.slice(0, 7)}). Re-request the review.`);
  }
  const [files, checks, qa] = await Promise.all([
    reader.listFiles(repo, prNumber),
    // Supporting context only: a fine-grained PAT without "Checks: read" gets a
    // 403 here (seen on the first real run). Don't fail the review over it;
    // null makes the comment say the section is unavailable instead of omitting it.
    reader.listCheckRuns(repo, pr.head.sha).catch((err) => {
      console.warn(`::warning::Could not read check runs, continuing without them: ${err.message}`);
      return null;
    }),
    loadQaData(reader, repo, pr.base.ref),
  ]);

  const names = files.map((f) => f.filename);
  const { areas, unmapped } = mapAreas(names, qa.areaPaths);
  const diff = buildDiff(files, maxDiffChars);
  if (!diff.shown.length) {
    throw new Error("No reviewable diff: every changed file was skipped, binary, or over the size limit.");
  }

  const { data, usage } = await chat(systemPrompt, buildUserMessage({ pr, areas, checks, qa, diff }), null);
  if (!data || typeof data !== "object") throw new Error("Model returned unparseable output; nothing to post.");
  // Size = what the model was actually shown, so a huge PR with a tiny shown part isn't over-credited.
  const changedLines = files.filter((f) => diff.shown.includes(f.filename)).reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const review = validateReview(data, { addedByFile: diff.addedByFile, titles: qa.titles, limits: limitsFor(changedLines) });
  // An empty summary means the model refused or derailed. Posting "no risks found"
  // from that would read as a clean bill of health, which is the wrong failure mode.
  if (!review.summary) throw new Error("Model returned no usable summary; refusing to post an empty review.");

  const body = renderComment({
    review,
    facts: {
      headSha: pr.head.sha,
      areas,
      unmapped,
      // Don't list our own pending run among "other checks".
      checks: checks && checks.filter((c) => !/^qa review/i.test(c.name)),
      shown: diff.shown,
      omitted: diff.omitted,
      noPatch: diff.noPatch,
      testsTouched: names.filter(isTestFile),
      qaDataPresent: qa.present,
      usage,
      model: usage?.model,
    },
  });
  // Fail safe: only an explicit `false` counts as public. The review is analysis
  // of the repo's code, and this workflow's own run summary/logs are public.
  const isPrivate = pr.base?.repo?.private !== false;
  return { body, review, usage, isPrivate, changedLines };
}

async function main() {
  const { QA_REPO, QA_PR, QA_HEAD_SHA, QA_BODY_OUT = "qa-review-body.md" } = process.env;
  if (!QA_REPO || !QA_PR || !/^[0-9a-f]{40}$/.test(QA_HEAD_SHA ?? "")) throw new Error("QA_REPO, QA_PR and a 40-char QA_HEAD_SHA are required");
  const token = ghTokenForRepo(QA_REPO);
  if (!token) throw new Error(`No bot token configured for ${QA_REPO}'s org`);

  const out = await runReview({
    repo: QA_REPO,
    prNumber: QA_PR,
    expectedSha: QA_HEAD_SHA,
    reader: makeReader(token),
    chat: chatJSONWithUsage,
    systemPrompt: readFileSync(new URL("../prompts/qa-review.md", import.meta.url), "utf8"),
  });
  writeFileSync(QA_BODY_OUT, out.body + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `repo_private=${out.isPrivate}\n`);
  console.log(`Wrote ${QA_BODY_OUT}: ${out.review.risks.length} risks, ${out.review.manual.length} manual tests, ${out.review.scenarios.length} scenarios; dropped ${JSON.stringify(out.review.dropped)}; usage ${JSON.stringify(out.usage)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
