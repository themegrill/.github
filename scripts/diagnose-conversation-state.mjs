#!/usr/bin/env node
import { credsForAccount, crispGet } from "./crisp-client.mjs";
const { ACCOUNT_KEY, TARGET_SESSION_ID } = process.env;
async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);
  const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${TARGET_SESSION_ID}`);
  console.log(JSON.stringify({ state: data.state, created_at: data.created_at, updated_at: data.updated_at, active: data.active }, null, 2));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
