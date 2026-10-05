#!/usr/bin/env node
// Fills wporg/prompt.md. Separate from scripts/build-prompt.mjs (Crisp's) so
// the wp.org-only placeholders never touch the Crisp pipeline.
import { readFile } from "node:fs/promises";

const [templatePath, repo, issueRepo, kind, slug, topicUrl, transcriptPath] = process.argv.slice(2);
if (!templatePath || !repo || !issueRepo || !kind || !slug || !topicUrl || !transcriptPath) {
  console.error("Usage: wporg-build-prompt.mjs <template> <code_repo> <issue_repo> <kind> <slug> <topic_url> <transcript>");
  process.exit(1);
}
const [raw, transcript] = await Promise.all([readFile(templatePath, "utf8"), readFile(transcriptPath, "utf8")]);

// The transcript is untrusted: substitute it LAST and in one pass so text in
// it that looks like a placeholder is never expanded.
const out = raw
  .replace(/^<!--[\s\S]*?-->\n*/, "")
  .replaceAll("{{ISSUE_REPO}}", issueRepo)
  .replaceAll("{{REPO}}", repo)
  .replaceAll("{{KIND}}", kind)
  .replaceAll("{{SESSION_ID}}", slug)
  .replaceAll("{{CONVERSATION_URL}}", topicUrl)
  .replace("{{TRANSCRIPT}}", () => transcript);
process.stdout.write(out);
