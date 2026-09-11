#!/usr/bin/env node
import { fetchRawMessages, credsForAccount, fetchResolvedConversationsSince } from "./crisp-client.mjs";

const creds = credsForAccount("USER_REGISTRATION");
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const conversations = await fetchResolvedConversationsSince(creds, since);
console.log(`found ${conversations.length} resolved conversations`);
if (conversations.length > 0) {
  const messages = await fetchRawMessages(creds, conversations[0].session_id);
  console.log(JSON.stringify(messages[0], null, 2));
  console.log("--- conversation object keys ---");
  console.log(JSON.stringify(Object.keys(conversations[0])));
  console.log(JSON.stringify(conversations[0], null, 2));
}
