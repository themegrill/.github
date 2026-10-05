#!/usr/bin/env node
// Posts a private note into a Crisp conversation. Called by the Stage 2
// agent so support gets a signal even when no issue was filed.
//
// A conversation investigated more than once can get the same "matched/
// created issue #N" note posted repeatedly. Skip only if EVERY issue URL in
// the new note is already mentioned in an existing note -- a note can
// reference two issues, and one being new is reason enough to still post.
// Keyed on the URL, not wording. A note with no issue URL isn't deduped.
import { readFile, writeFile } from "node:fs/promises";
import { postNote, fetchRawMessages } from "./crisp-client.mjs";

const [sessionId, noteArg] = process.argv.slice(2);
if (!sessionId || !noteArg) {
  console.error('Usage: crisp-post-note.mjs <session_id> "<note text>"  (or: crisp-post-note.mjs <session_id> @<path-to-note-file>)');
  process.exit(1);
}

// `@path` (curl's convention) reads the note from a file instead of the
// argument -- a multi-line note as a shell argument is fragile (bash
// doesn't interpret literal `\n` inside double quotes).
const rawNote = noteArg.startsWith("@") ? await readFile(noteArg.slice(1), "utf8") : noteArg;

// Safety net: normalize literal \n / \r\n sequences to real newlines in case any made it through.
// Also collapse runs of blank lines (3+ newlines -> one blank line): models pad
// sections with extra blank lines, which makes a Crisp note hard to scan.
const note = rawNote.replace(/\\r\\n|\\n/g, "\n").replace(/[ \t]*\n(?:[ \t]*\n){2,}/g, "\n\n");

// Leave a local copy for the workflow's event step, which parses the outcome
// from it. Done here, before any Crisp call, so it exists even when the post is
// skipped as a duplicate below. The event-writing token is deliberately NOT in
// this process's env (this runs inside the agent) -- only a file path is.
if (process.env.NOTE_RECORD_PATH) {
  try {
    await writeFile(process.env.NOTE_RECORD_PATH, note);
  } catch (err) {
    console.error(`Could not record note copy (non-fatal): ${err.message}`);
  }
}

const creds = {
  identifier: process.env.CRISP_IDENTIFIER,
  key: process.env.CRISP_KEY,
  websiteId: process.env.CRISP_WEBSITE_ID,
};

// The draft customer reply (marker format mirrors events-parse.mjs; this file
// is copied alone to $HOME by the workflow, so it can't import that module) is
// excluded from URL dedupe -- it must never contain issue links anyway.
const DRAFT_MARKER = /^[ \t]*={2,}[ \t]*DRAFT REPLY\b/im;
const draftStart = /^[ \t]*={2,}[ \t]*DRAFT REPLY\b.*$/im.exec(note);
const report = draftStart ? note.slice(0, draftStart.index) : note;
const draft = draftStart ? note.slice(draftStart.index) : "";
const issueUrls = [...report.matchAll(/https:\/\/github\.com\/[^\s)]+\/issues\/\d+/g)].map((m) => m[0]);

// Soft checks only, printed into the agent's tool output so it can see them.
// Never block the post: the note is the mandatory last step and a lost note is
// worse than a malformed one (the workflow fails the job if this isn't called).
const rawCategory = report.match(/^\s*[-*]\s*Category\s*:\s*([`*\w ]+)/im)?.[1]?.toLowerCase().replace(/[`*]/g, "").trim().split(/\s+/)[0];
const category = rawCategory === "plugin_bug" ? "product_bug" : rawCategory; // legacy name
if (!category) console.warn("Warning: note has no '- Category:' line (expected product_bug | conflict | host | user_error | undetermined | not_applicable).");
if (!draftStart) console.warn("Warning: note has no '=== DRAFT REPLY ... ===' block for staff.");
else if (!/^[ \t]*={2,}[ \t]*END DRAFT\b/im.test(draft)) console.warn("Warning: draft reply block is missing its '=== END DRAFT ===' line.");
if (category && category !== "product_bug" && /^\s*[-*]\s*Bug\s*:\s*(filed|already tracked)/im.test(report)) {
  console.warn(`Warning: category is ${category} but the note reports a bug issue as filed/tracked; only product_bug may be filed or commented on.`);
}
if (/https?:\/\/|issues?\s*#\d+|#\d{2,}|[\w./-]+\.(php|js|jsx|ts|tsx|css):\d+/i.test(draft)) {
  console.warn("Warning: draft reply contains a URL, issue number, or file path; customer drafts must not.");
}

async function main() {
  if (issueUrls.length > 0) {
    const messages = await fetchRawMessages(creds, sessionId);
    const existingNotes = messages.filter((m) => m.type === "note").map((m) => m.content ?? "");
    const allAlreadyNoted = issueUrls.every((url) => existingNotes.some((content) => content.includes(url)));
    if (allAlreadyNoted) {
      // The skip above predates the draft reply. If this conversation has never
      // received a draft (e.g. its earlier note was posted before drafts
      // existed), skipping would silently drop the category and draft staff
      // need. Post ONE reduced note then (no issue links, so no duplicate
      // noise); once any note on the conversation carries a draft, the
      // original skip applies again, so re-investigations don't pile up notes.
      const hasEarlierDraft = existingNotes.some((content) => DRAFT_MARKER.test(content));
      if (draftStart && !hasEarlierDraft) {
        const reduced = note
          .split("\n")
          .filter((line) => !/^\s*[-*]\s*(Bug|Feature request)\s*:/i.test(line))
          .join("\n")
          .replace(/\n+([ \t]*=+[ \t]*DRAFT REPLY)/i, "\n- Issue already tracked in an earlier note on this conversation.\n\n$1");
        await postNote(creds, sessionId, reduced);
        console.log(`Note posted (reduced, draft only) to conversation ${sessionId} -- issue(s) already noted earlier`);
        return;
      }
      console.log(`Skipping note -- all referenced issue(s) (${issueUrls.join(", ")}) already mentioned in an existing note on conversation ${sessionId}`);
      return;
    }
  }
  await postNote(creds, sessionId, note);
  console.log(`Note posted to conversation ${sessionId}`);
}

main().catch((err) => {
  console.error(`Failed to post Crisp note: ${err.message}`);
  process.exit(1);
});
