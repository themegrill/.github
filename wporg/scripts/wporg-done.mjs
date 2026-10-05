#!/usr/bin/env node
// The agent's mandatory last step (the wp.org counterpart of crisp-post-note).
// There is no forum/Crisp note to post -- nothing is ever written back to
// wordpress.org. This only validates and prints the final report so the
// workflow can tell "agent finished" from "agent died mid-run".
import { readFile } from "node:fs/promises";

const [url, arg] = process.argv.slice(2);
if (!url || !arg) {
  console.error("Usage: wporg-done.mjs <topic_url> @<report-file>");
  process.exit(1);
}
const text = arg.startsWith("@") ? await readFile(arg.slice(1), "utf8") : arg;
const warn = (m) => console.error(`warning: ${m}`);
if (!/^\s*Investigation report:/m.test(text)) warn('report should start with "Investigation report:"');
if (!/^\s*-\s*Category:\s*(product_bug|conflict|host|user_error|undetermined|not_applicable)\b/m.test(text))
  warn("missing or invalid Category line");
const cat = text.match(/Category:\s*(\w+)/)?.[1];
if (cat && cat !== "product_bug" && /^\s*-\s*Bug:\s*(Filed|Already tracked)/m.test(text))
  warn("a non-product_bug report must not file or track a bug");
console.log(`WP.ORG TOPIC: ${url}\n${text.trim()}`);
