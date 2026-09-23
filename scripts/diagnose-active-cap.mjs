#!/usr/bin/env node
// One-off, read-only diagnostic: how many unresolved conversations does this
// account actually have, and where does TARGET_SESSION_ID rank in the same
// order_date_updated=1 sort that fetchActiveConversations uses? Answers
// whether the 10-page/200-item cap is actually why a given session gets
// missed, instead of guessing from code alone.
import { credsForAccount, crispGet } from "./crisp-client.mjs";

const { ACCOUNT_KEY, TARGET_SESSION_ID } = process.env;
if (!ACCOUNT_KEY || !TARGET_SESSION_ID) {
  console.error("Missing required env vars: ACCOUNT_KEY, TARGET_SESSION_ID");
  process.exit(1);
}

async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);
  const conversations = [];
  let rank = -1;
  let hitRateLimit = false;

  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({ filter_not_resolved: "true", order_date_updated: "1" });
    let data;
    try {
      ({ data } = await crispGet(creds, `/website/${creds.websiteId}/conversations/${page}?${params}`));
    } catch (err) {
      console.error(`Page ${page} request failed: ${err.message}`);
      hitRateLimit = true;
      break;
    }
    if (!data || data.length === 0) break;
    conversations.push(...data);
    const idx = data.findIndex((c) => c.session_id === TARGET_SESSION_ID);
    if (idx !== -1 && rank === -1) rank = conversations.length - data.length + idx + 1;
    console.log(`Page ${page}: ${data.length} conversations (running total ${conversations.length})`);
    if (data.length < 20) break;
  }

  console.log(`\n=== Result for ${ACCOUNT_KEY} ===`);
  console.log(`Total unresolved conversations fetched: ${conversations.length}${hitRateLimit ? " (stopped early -- rate limited)" : ""}`);
  console.log(`Current 10-page/200-item cap covers ranks 1-200.`);
  if (rank === -1) {
    console.log(`${TARGET_SESSION_ID}: NOT FOUND within ${conversations.length} fetched (either resolved right now, or beyond page 50).`);
  } else {
    console.log(`${TARGET_SESSION_ID}: rank ${rank} by most-recently-updated -- ${rank <= 200 ? "WITHIN" : "OUTSIDE"} the current 200-item cap.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
