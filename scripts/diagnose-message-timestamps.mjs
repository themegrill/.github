#!/usr/bin/env node
// Read-only, no content/sender exposed -- just type+timestamp, to check
// whether any message is newer than a given cutoff.
import { credsForAccount, crispGet } from "./crisp-client.mjs";
const { ACCOUNT_KEY, TARGET_SESSION_ID, CUTOFF_MS } = process.env;
async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);
  const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${TARGET_SESSION_ID}/messages`);
  const cutoff = Number(CUTOFF_MS);
  console.log(`Total messages: ${data.length}`);
  console.log(`Cutoff: ${cutoff}`);
  for (const m of data) {
    console.log(JSON.stringify({ type: m.type, timestamp: m.timestamp, newer_than_cutoff: (m.timestamp ?? 0) > cutoff }));
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
