#!/usr/bin/env node
import { credsForAccount, crispGet } from "./crisp-client.mjs";
const { ACCOUNT_KEY, TARGET_SESSION_ID } = process.env;
async function main() {
  const creds = credsForAccount(ACCOUNT_KEY);
  const conversations = [];
  let rank = -1;
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({ filter_not_resolved: "true", order_date_updated: "1" });
    const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversations/${page}?${params}`);
    if (!data || data.length === 0) break;
    conversations.push(...data);
    const idx = data.findIndex((c) => c.session_id === TARGET_SESSION_ID);
    if (idx !== -1 && rank === -1) rank = conversations.length - data.length + idx + 1;
    if (data.length < 20) break;
  }
  console.log(`Total unresolved fetched: ${conversations.length}`);
  console.log(`Current 10-page/200-item cap covers ranks 1-200.`);
  console.log(rank === -1 ? `NOT FOUND within ${conversations.length} fetched.` : `rank ${rank} -- ${rank <= 200 ? "WITHIN" : "OUTSIDE"} the 200-item cap.`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
