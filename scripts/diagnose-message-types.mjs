#!/usr/bin/env node
import { credsForAccount, crispGet } from "./crisp-client.mjs";

const { ACCOUNT_KEY, TARGET_SESSION_ID } = process.env;
async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);
  const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${TARGET_SESSION_ID}/messages`);
  console.log(`Total raw messages: ${data.length}`);
  const nonText = data.filter((m) => m.type !== "text");
  console.log(`Non-text messages: ${nonText.length}`);
  for (const m of nonText) {
    console.log(JSON.stringify({ type: m.type, from: m.from, content: m.content, timestamp: m.timestamp }));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
