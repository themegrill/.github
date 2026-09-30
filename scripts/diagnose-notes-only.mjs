#!/usr/bin/env node
// Read-only, narrow: only type==="note" entries (our own agent/team notes,
// never customer messages), matching exactly what crisp-post-note.mjs's own
// dedupe check reads. Content included since these are our own notes, not PII.
import { credsForAccount, fetchRawMessages } from "./crisp-client.mjs";
const { ACCOUNT_KEY, TARGET_SESSION_ID } = process.env;
async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);
  const messages = await fetchRawMessages(creds, TARGET_SESSION_ID);
  const notes = messages.filter((m) => m.type === "note");
  console.log(`Total messages: ${messages.length}, notes: ${notes.length}`);
  for (const n of notes) {
    console.log(JSON.stringify({ timestamp: n.timestamp, content: n.content }));
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
