#!/usr/bin/env node
// One-off maintenance script: marks every currently-active conversation for
// one Crisp account as already checked, so a newly onboarded account's
// pre-existing backlog doesn't all fire in crisp-triage.yml's first run.
// Run via .github/workflows/seed-escalated.yml once per new account, before
// its first scheduled crisp-triage run.
//
// Only blocks the AUTO-escalation path -- doesn't touch the resolved-
// conversation loop (already forward-only via cursor.json) and doesn't
// block a manual "!tg-autopilot investigate" note, which never checks this.
//
// checkedThroughAt MUST come from real message timestamps (fetchRawMessages),
// matching exactly what crisp-classify.mjs itself compares against -- NOT
// conversation-level metadata (updated_at/active.last). Confirmed for real
// this was a genuine bug, not a theoretical one: seeding from updated_at
// undercounted real activity for a large fraction of a backlog, so those
// conversations immediately looked "newer than the seed mark" again and
// fired anyway on the very next run, defeating the whole point of seeding.
//
// --force recomputes and overwrites every entry (used to correct a prior
// bad seed); without it, only conversations with no checkedThroughAt yet
// are touched, which is what real new-account onboarding wants.
import { readFile, writeFile } from "node:fs/promises";
import { fetchActiveConversations, fetchRawMessages, credsForAccount } from "./crisp-client.mjs";

const [accountKey, flag] = process.argv.slice(2);
const force = flag === "--force";
if (!accountKey) {
  console.error("Usage: seed-escalated.mjs <ACCOUNT_KEY> [--force]");
  process.exit(1);
}

async function main() {
  const creds = credsForAccount(accountKey);
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));
  const conversations = await fetchActiveConversations(creds);

  let seeded = 0;
  for (const conversation of conversations) {
    const record = escalated[conversation.session_id] ?? { manualNoteCount: 0 };
    if (force || record.checkedThroughAt === undefined) {
      const messages = await fetchRawMessages(creds, conversation.session_id);
      record.checkedThroughAt = messages.reduce((max, m) => Math.max(max, m.timestamp ?? 0), 0);
      escalated[conversation.session_id] = record;
      seeded++;
    }
  }

  await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");
  console.log(`[${accountKey}] seeded ${seeded} of ${conversations.length} active conversations as already-checked (backlog skip).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
