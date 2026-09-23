#!/usr/bin/env node
// One-off, read-only diagnostic: fetch a single conversation's own record
// (and its dedicated state endpoint) directly from Crisp, rather than
// inferring state from a list-filter query. Prints raw state/timestamps.
import { credsForAccount, crispGet } from "./crisp-client.mjs";

const { ACCOUNT_KEY, TARGET_SESSION_ID } = process.env;
if (!ACCOUNT_KEY || !TARGET_SESSION_ID) {
  console.error("Missing required env vars: ACCOUNT_KEY, TARGET_SESSION_ID");
  process.exit(1);
}

async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);

  console.log(`=== GET /website/${creds.websiteId}/conversation/${TARGET_SESSION_ID} ===`);
  try {
    const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${TARGET_SESSION_ID}`);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Conversation fetch failed: ${err.message}`);
  }

  console.log(`\n=== GET /website/${creds.websiteId}/conversation/${TARGET_SESSION_ID}/state ===`);
  try {
    const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${TARGET_SESSION_ID}/state`);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`State fetch failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
