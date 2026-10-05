#!/usr/bin/env node
// Did the agent actually RUN wporg-done.mjs? A plain grep for the filename
// also matches the prompt text, so inspect tool-call events only.
// Prints the report it submitted (for the job log) and exits 0, else exits 1.
import { readFile } from "node:fs/promises";

const [path] = process.argv.slice(2);
const raw = await readFile(path, "utf8");
let found = null;
for (const line of raw.split("\n")) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  // Skip the model's own prose; tool-call events (whatever their exact shape
  // in this opencode version) are everything else. The raw output is uploaded
  // as an artifact by the workflow so this can be tightened against a real one.
  if (ev.type === "text" || ev.type === "reasoning") continue;
  if (/wporg-done\.mjs/.test(JSON.stringify(ev.part ?? ev))) found = ev;
}
if (!found) {
  console.error("No tool call to wporg-done.mjs found in the agent output.");
  process.exit(1);
}
const out = found.part?.state?.output ?? found.part?.output;
console.log(typeof out === "string" && out.trim() ? out.trim() : "(wporg-done.mjs ran but returned no output)");
