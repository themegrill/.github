import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEDUPE_MAX_QUIET_DAYS,
  isCustomerText,
  newestTextTimestamp,
  newestCustomerTextTimestamp,
  conversationActivityHint,
  isCustomerQuiet,
  shouldReclassifyStale,
  nextCheckedThroughAt,
} from "./crisp-activity.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T00:00:00Z");
const at = (iso) => Date.parse(iso);

// Mirrors the real shape of session_3931e910 (types/roles/timestamps only).
const msgs = [
  { type: "text", from: "user", timestamp: at("2026-10-09T09:53:17Z") },
  { type: "note", from: "operator", timestamp: at("2026-10-09T15:38:02Z") },
  { type: "text", from: "operator", timestamp: at("2026-10-13T03:32:13Z") },
  { type: "note", from: "operator", timestamp: at("2026-10-13T12:08:29Z") },
];

test("isCustomerText: only text from the user", () => {
  assert.equal(isCustomerText({ type: "text", from: "user" }), true);
  assert.equal(isCustomerText({ type: "text", from: "operator" }), false);
  assert.equal(isCustomerText({ type: "note", from: "user" }), false);
  assert.equal(isCustomerText({ type: "file", from: "user" }), false);
});

test("newestTextTimestamp counts agent text but not notes/events", () => {
  assert.equal(newestTextTimestamp(msgs), at("2026-10-13T03:32:13Z"));
  assert.equal(newestTextTimestamp([{ type: "event", from: "operator", timestamp: 999 }]), 0);
});

test("newestCustomerTextTimestamp ignores agent replies and notes", () => {
  assert.equal(newestCustomerTextTimestamp(msgs), at("2026-10-09T09:53:17Z"));
  assert.equal(newestCustomerTextTimestamp([]), 0);
  assert.equal(newestCustomerTextTimestamp([], 5), 5);
});

test("shouldReclassifyStale: an agent reply alone does NOT re-arm (3931e910 regression)", () => {
  // Already checked through the customer's Oct 9 message; agent replied Oct 13.
  assert.equal(shouldReclassifyStale(msgs, at("2026-10-09T09:53:17Z")), false);
});

test("shouldReclassifyStale: a newer customer message re-arms", () => {
  const withNewCustomer = [...msgs, { type: "text", from: "user", timestamp: at("2026-10-13T20:00:00Z") }];
  assert.equal(shouldReclassifyStale(withNewCustomer, at("2026-10-13T03:32:13Z")), true);
});

test("shouldReclassifyStale: never-checked conversation is classified once", () => {
  assert.equal(shouldReclassifyStale(msgs, undefined), true);
  assert.equal(shouldReclassifyStale([], undefined), true);
});

test("shouldReclassifyStale: existing marker stamped from agent text still holds", () => {
  // Real state: checkedThroughAt = Oct 13 03:32 (an agent reply). Customer's
  // newest message is older, so nothing re-arms.
  assert.equal(shouldReclassifyStale(msgs, at("2026-10-13T03:32:13Z")), false);
});

test("nextCheckedThroughAt never moves backwards", () => {
  const existing = at("2026-10-13T03:32:13Z");
  assert.equal(nextCheckedThroughAt(msgs, existing), existing);
  assert.equal(nextCheckedThroughAt(msgs, undefined), at("2026-10-09T09:53:17Z"));
  assert.equal(nextCheckedThroughAt([], undefined), 0);
});

test("conversationActivityHint: takes the newest metadata, tolerates missing active.last", () => {
  const convo = { created_at: 100, updated_at: 300 }; // active.last absent, like email threads
  assert.equal(conversationActivityHint(convo), 300);
  assert.equal(conversationActivityHint({ created_at: 100, updated_at: 300, active: { last: 500 } }), 500);
  assert.equal(conversationActivityHint({ created_at: 100 }), 100);
});

test("isCustomerQuiet: f9e20b9b shape (one customer msg in Aug, bot note in Oct) is quiet", () => {
  const f9e2 = [
    { type: "text", from: "user", timestamp: at("2026-08-06T16:11:57Z") },
    { type: "text", from: "operator", timestamp: at("2026-08-12T08:07:30Z") },
    { type: "event", from: "operator", timestamp: at("2026-08-14T04:11:34Z") },
    { type: "note", from: "operator", timestamp: at("2026-10-13T23:52:03Z") },
  ];
  assert.equal(isCustomerQuiet(f9e2, NOW), true);
});

test("isCustomerQuiet: boundary around the window", () => {
  const fresh = [{ type: "text", from: "user", timestamp: NOW - (DEDUPE_MAX_QUIET_DAYS - 1) * DAY }];
  const old = [{ type: "text", from: "user", timestamp: NOW - (DEDUPE_MAX_QUIET_DAYS + 1) * DAY }];
  assert.equal(isCustomerQuiet(fresh, NOW), false);
  assert.equal(isCustomerQuiet(old, NOW), true);
});

test("isCustomerQuiet: a recent agent reply or note does not make it fresh", () => {
  const m = [
    { type: "text", from: "user", timestamp: NOW - 30 * DAY },
    { type: "text", from: "operator", timestamp: NOW - 1 * DAY },
    { type: "note", from: "operator", timestamp: NOW - 1000 },
  ];
  assert.equal(isCustomerQuiet(m, NOW), true);
});

test("isCustomerQuiet: no customer text at all counts as quiet", () => {
  assert.equal(isCustomerQuiet([], NOW), true);
  assert.equal(isCustomerQuiet([{ type: "text", from: "operator", timestamp: NOW }], NOW), true);
});
