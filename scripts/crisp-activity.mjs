// Pure helpers for judging real conversation activity from fetched Crisp messages.
// Customer messages drive re-investigation; `active.last` is often absent and
// `updated_at` is bumped by our own notes, so neither proves real activity.

// crisp-dedupe-active.mjs skips threads whose newest customer message is older than this.
export const DEDUPE_MAX_QUIET_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isCustomerText(message) {
  return message.type === "text" && message.from === "user";
}

// Newest customer-or-agent text. Notes (including ours) and events are excluded.
export function newestTextTimestamp(messages, floor = 0) {
  return messages.reduce((max, m) => (m.type === "text" ? Math.max(max, m.timestamp ?? 0) : max), floor);
}

// Newest customer-written message; agent replies, notes and events never count.
export function newestCustomerTextTimestamp(messages, floor = 0) {
  return messages.reduce((max, m) => (isCustomerText(m) ? Math.max(max, m.timestamp ?? 0) : max), floor);
}

// Newest metadata timestamp, as a hint for whether to fetch messages at all.
// Callers must re-check against real messages before acting.
export function conversationActivityHint(conversation) {
  return Math.max(conversation.active?.last ?? 0, conversation.updated_at ?? 0, conversation.created_at ?? 0);
}

// True if the customer wrote nothing within `maxQuietDays` (no customer text counts as quiet).
export function isCustomerQuiet(messages, now = Date.now(), maxQuietDays = DEDUPE_MAX_QUIET_DAYS) {
  const newest = newestCustomerTextTimestamp(messages);
  return newest === 0 || now - newest > maxQuietDays * DAY_MS;
}

// Reclassify only if never checked, or the customer wrote after the last check.
export function shouldReclassifyStale(messages, checkedThroughAt) {
  if (checkedThroughAt === undefined) return true;
  return newestCustomerTextTimestamp(messages) > checkedThroughAt;
}

// Marker to store after a stale check; never moves backwards past existing entries.
export function nextCheckedThroughAt(messages, checkedThroughAt) {
  return newestCustomerTextTimestamp(messages, checkedThroughAt ?? 0);
}
