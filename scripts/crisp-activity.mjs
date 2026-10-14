// Pure helpers for judging "has anything real happened in this conversation
// lately?" from fetched Crisp messages. No network, no env -- unit-tested in
// crisp-activity.test.mjs.
//
// Why this exists (confirmed for real, session_3931e910 and session_f9e20b9b):
//  - Email-origin conversations come back with NO `active.last` at all, so
//    `active.last ?? created_at` silently measured age-since-creation, not
//    time-since-activity.
//  - `updated_at` is bumped by this pipeline's own notes, so it is only a hint
//    for "worth fetching messages", never proof that a human did anything.
//  - A support agent's reply re-armed the stale-escalate check as if the
//    customer had written again, re-investigating (and re-noting) a thread
//    that was already triaged.
// Real freshness therefore comes from message timestamps, and "new activity"
// that should trigger an investigation is a new CUSTOMER message.

// crisp-dedupe-active.mjs skips a conversation whose newest customer message
// is older than this. Dedupe is about a customer's reported problem; a thread
// the customer went quiet on weeks ago isn't worth a note/comment.
export const DEDUPE_MAX_QUIET_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isCustomerText(message) {
  return message.type === "text" && message.from === "user";
}

// Newest timestamp among real conversation text (customer OR agent). Private
// notes -- including this pipeline's own "Investigation report" notes -- and
// event/picker messages are excluded.
export function newestTextTimestamp(messages, floor = 0) {
  return messages.reduce((max, m) => (m.type === "text" ? Math.max(max, m.timestamp ?? 0) : max), floor);
}

// Newest timestamp among messages the CUSTOMER wrote. Support replies, notes
// and events never count. Returns `floor` (default 0) if there are none.
export function newestCustomerTextTimestamp(messages, floor = 0) {
  return messages.reduce((max, m) => (isCustomerText(m) ? Math.max(max, m.timestamp ?? 0) : max), floor);
}

// Conversation-level "last activity" HINT, used only to decide whether it is
// worth fetching messages at all. Takes the newest of every metadata field
// that exists, since `active.last` is frequently absent (see above). Never
// the final word on freshness -- callers re-check against real messages.
export function conversationActivityHint(conversation) {
  return Math.max(conversation.active?.last ?? 0, conversation.updated_at ?? 0, conversation.created_at ?? 0);
}

// True if the customer has not written anything within `maxQuietDays`, judged
// from real message timestamps. A conversation with no customer text at all
// counts as quiet.
export function isCustomerQuiet(messages, now = Date.now(), maxQuietDays = DEDUPE_MAX_QUIET_DAYS) {
  const newest = newestCustomerTextTimestamp(messages);
  return newest === 0 || now - newest > maxQuietDays * DAY_MS;
}

// Should the stale-escalate path (re)classify? Only when the customer has
// written something newer than what was already checked -- or nothing has
// been checked yet. Agent replies can never re-arm it.
export function shouldReclassifyStale(messages, checkedThroughAt) {
  if (checkedThroughAt === undefined) return true;
  return newestCustomerTextTimestamp(messages) > checkedThroughAt;
}

// The marker to store after a stale check. Never moves backwards: existing
// entries were stamped from agent text too, so a customer-only value could
// otherwise be lower than what is already recorded.
export function nextCheckedThroughAt(messages, checkedThroughAt) {
  return newestCustomerTextTimestamp(messages, checkedThroughAt ?? 0);
}
