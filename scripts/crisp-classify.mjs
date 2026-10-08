#!/usr/bin/env node
// Stage 1 of the Crisp -> AI -> GitHub issue pipeline. A resolved
// conversation is trusted as fully handled by support and never
// investigated on its own -- only a reopen, a manual note, or a
// stale-never-resolved conversation can trigger Stage 2. See
// PHASE2-SETUP.md § 4c for the full policy.
//
// Provider: OpenAI, swappable freely. Verify CLASSIFY_MODEL against your
// account before relying on it.
import { readFile, writeFile } from "node:fs/promises";
import {
  conversationUrl,
  fetchResolvedConversationsSince,
  fetchActiveConversations,
  searchConversationsForManualTrigger,
  fetchRawMessages,
  countManualTriggerNotes,
  credsForAccount,
} from "./crisp-client.mjs";
import { classifyAndRoute } from "./crisp-classifier.mjs";
import { emitEvent } from "./events.mjs";

const { GITHUB_STEP_SUMMARY } = process.env;
const AUTO_ESCALATE_HOURS = 12;
const AUTO_ESCALATE_MAX_HOURS = 24 * 30; // past this, only a manual note escalates it

// One entry per conversation that reached the classifier this run -- becomes
// the `scan` event (see events.mjs). Ids, enums and costs only, no text.
const scanRecords = [];
// Escalated conversations for the step summary only (links + confidence);
// kept apart from scanRecords because that becomes the event log.
const escalatedRows = [];
function recordScan(path, account, sessionId, result, { manual = false } = {}) {
  const escalated = !!result.repo && (manual || (result.actionable && result.kind !== "none"));
  if (escalated) {
    escalatedRows.push({
      url: conversationUrl(credsForAccount(account), sessionId),
      repo: result.repo,
      kind: result.kind ?? "bug",
      path: manual ? "manual note" : path,
      confidence: manual ? null : (result.confidence ?? null),
    });
  }
  scanRecords.push({
    session_id: sessionId,
    account,
    path,
    repo: result.repo ?? null,
    kind: result.kind ?? null,
    actionable: manual ? true : (result.actionable ?? null),
    escalated,
    reason: escalated ? null : result.repo ? "not_actionable" : "unmapped",
    classifier: result.usage ?? null,
  });
}

function transcriptFrom(messages) {
  return messages
    .filter((m) => m.type === "text")
    .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");
}

// Newest timestamp among real conversation messages only (customer/agent
// text). Private notes -- including this pipeline's own "Investigation
// report" notes -- and event messages are excluded: Stage 2 posts its note
// AFTER Stage 1 stamps the marker, so counting notes made every investigation
// look like "new activity" on the next run and re-investigated the same
// conversation every few hours (confirmed on session_bd0acc7b). Only the
// automatic stale/reopen paths use this; manual-note branches are unchanged.
function newestTextTimestamp(messages, floor = 0) {
  return messages.reduce((max, m) => (m.type === "text" ? Math.max(max, m.timestamp ?? 0) : max), floor);
}

// A rate-limit failure (crispFetch already retried and gave up) on ONE session
// shouldn't kill the whole run -- that skips "Commit advanced state" and
// loses every other session's progress. Returns null so callers can skip it.
// Anything other than a 429 (auth, 5xx, bugs) still throws.
async function fetchMessagesOrSkip(creds, sessionId, label) {
  try {
    return await fetchRawMessages(creds, sessionId);
  } catch (err) {
    if (!String(err.message).includes(" 429 ")) throw err;
    console.warn(`[${label}] ${sessionId}: rate limited fetching messages, skipping this session (${err.message.slice(0, 120)})`);
    return null;
  }
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const cursor = JSON.parse(await readFile("state/cursor.json", "utf8"));
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;
  // Avoid a redundant comment for anything the dedupe check already matched.
  const activeNotified = new Set(
    JSON.parse(await readFile("state/active-notified.json", "utf8").catch(() => "[]"))
  );
  // { [session_id]: { manualNoteCount: number, checkedThroughAt?: number } }
  // checkedThroughAt is the newest message timestamp already considered by
  // the stale-auto-escalate check -- re-arms as soon as anything newer shows
  // up, rather than blocking a session forever after one check.
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));
  // session_ids already fully investigated once. Not checked for manual notes.
  const investigated = new Set(
    JSON.parse(await readFile("state/investigated.json", "utf8").catch(() => "[]"))
  );
  // { [session_id]: <ms timestamp of the last time we saw it resolved> }
  const resolvedSeen = JSON.parse(await readFile("state/resolved-seen.json", "utf8").catch(() => "{}"));

  const matrix = [];
  const skippedUnmapped = [];
  let alreadyHandled = 0;
  let totalFetched = 0;
  let manualEscalations = 0;
  let autoEscalations = 0;
  let reopenEscalations = 0;
  let resolvedFetchSkipped = 0;

  // Each Crisp account is handled independently; an uncredentialed one just warns.
  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch (err) {
      console.warn(`[${accountKey}] skipping: ${err.message}`);
      continue;
    }

    // Resolved conversations: just record as seen, unless a manual note overrides it.
    const conversations = await fetchResolvedConversationsSince(creds, cursor.last_checked);
    totalFetched += conversations.length;
    console.log(`[${accountKey}] fetched ${conversations.length} resolved conversations since ${cursor.last_checked}`);

    for (const conversation of conversations) {
      if (activeNotified.has(conversation.session_id)) {
        alreadyHandled++;
        continue;
      }

      // Raw messages, not just transcript, so we can also count manual notes.
      const messages = await fetchMessagesOrSkip(creds, conversation.session_id, accountKey);
      if (messages === null) {
        // Don't record it as seen, and hold the cursor back so the next run
        // refetches it (a manual note on it would otherwise be lost).
        resolvedFetchSkipped++;
        continue;
      }
      const transcript = transcriptFrom(messages);

      if (transcript.trim()) {
        const record = escalated[conversation.session_id] ?? { manualNoteCount: 0 };
        const manualNoteCount = countManualTriggerNotes(messages);
        const hasNewManualNote = manualNoteCount > record.manualNoteCount;

        if (hasNewManualNote) {
          const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
          recordScan("resolved_manual", accountKey, conversation.session_id, result, { manual: true });
          record.manualNoteCount = manualNoteCount;
          // Same reasoning as the active loop's manual-note branch: stamp it
          // so a later independent stale-fallback check doesn't redundantly
          // reprocess content a human already had investigated directly.
          record.checkedThroughAt = messages.reduce((max, m) => Math.max(max, m.timestamp ?? 0), record.checkedThroughAt ?? 0);
          escalated[conversation.session_id] = record;
          if (result.repo) {
            matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
            investigated.add(conversation.session_id);
            manualEscalations++;
            console.log(`[${accountKey}] ${conversation.session_id}: manual "!tg-autopilot investigate" note -> escalated to ${result.repo}`);
          } else {
            skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: result.unmappedKey });
          }
        }
      }

      // Always record the resolve, even if a manual note just fired above.
      resolvedSeen[conversation.session_id] = conversation.updated_at ?? Date.now();
    }

    // Active conversations: manual note, reopen, or time-based escalation.
    // Separate from crisp-dedupe-active.mjs, which skips anything in matrix.json.
    const lastCheckedMs = new Date(cursor.last_checked).getTime();
    const activeConversations = await fetchActiveConversations(creds);
    activeConversations.forEach((conversation) => {
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      conversation._checkManualNote = lastActiveAt > lastCheckedMs;
    });

    // Search directly for the trigger phrase too, in case the page cap buries it.
    const seenSessionIds = new Set(activeConversations.map((c) => c.session_id));
    const manualTriggerHits = await searchConversationsForManualTrigger(creds, "!tg-autopilot investigate");
    for (const hit of manualTriggerHits) {
      if (seenSessionIds.has(hit.session_id)) continue;
      hit._checkManualNote = true;
      activeConversations.push(hit);
      seenSessionIds.add(hit.session_id);
    }

    for (const conversation of activeConversations) {
      const record = escalated[conversation.session_id] ?? { manualNoteCount: 0 };
      const previousResolveAt = resolvedSeen[conversation.session_id];

      // active.last, not created_at, so a reopened thread isn't read as ancient.
      // NOTE: active.last (and even updated_at) can lag behind real message
      // activity, especially for email-origin conversations -- confirmed for
      // real (session_bd0acc7b showed live replies well after both fields
      // had stopped moving). So this is only used to decide whether it's
      // worth fetching messages at all, never as the final word on
      // freshness -- see checkedThroughAt below, which is timestamped from
      // the actual fetched messages instead.
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      const staleHours = (Date.now() - lastActiveAt) / (1000 * 60 * 60);
      const eligibleForAutoEscalate = staleHours >= AUTO_ESCALATE_HOURS && staleHours <= AUTO_ESCALATE_MAX_HOURS;

      // Seen resolved before, active again now -- a reopen.
      const isReopen = previousResolveAt !== undefined;

      if (!conversation._checkManualNote && !eligibleForAutoEscalate && !isReopen) continue;

      // On skip, nothing is recorded for this session, so the next run
      // re-evaluates it from scratch.
      const messages = await fetchMessagesOrSkip(creds, conversation.session_id, accountKey);
      if (messages === null) continue;
      const manualNoteCount = conversation._checkManualNote ? countManualTriggerNotes(messages) : record.manualNoteCount;
      const hasNewManualNote = manualNoteCount > record.manualNoteCount;

      if (!hasNewManualNote && !eligibleForAutoEscalate && !isReopen) continue;

      // A reopen only sees what's new since the previous resolve; a manual note gets everything.
      const relevantMessages = isReopen && !hasNewManualNote
        ? messages.filter((m) => (m.timestamp ?? 0) > previousResolveAt)
        : messages;
      let transcript = transcriptFrom(relevantMessages);
      // Pair a reopen's delta with the opening messages, or it reads as
      // routine follow-up with no idea what bug it's about. Capped to a few
      // messages, not the full history, to keep this cheap.
      if (isReopen && !hasNewManualNote && transcript.trim()) {
        const opening = transcriptFrom(messages.slice(0, 6));
        if (opening.trim()) {
          transcript = `[Original report]\n${opening}\n\n[New activity since last checked]\n${transcript}`;
        }
      }
      // A reopen with nothing new since the resolve isn't "handled" -- often
      // a spurious/premature resolve on an otherwise-stale, never-addressed
      // conversation (confirmed for real: session_bd0acc7b). Fall back to a
      // full-history stale check instead of silently skipping it forever.
      const reopenHasNothingNew = isReopen && !hasNewManualNote && !transcript.trim();
      if (reopenHasNothingNew && eligibleForAutoEscalate) {
        transcript = transcriptFrom(messages);
      }
      if (!transcript.trim()) continue;

      if (hasNewManualNote) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
        recordScan("active_manual", accountKey, conversation.session_id, result, { manual: true });
        record.manualNoteCount = manualNoteCount;
        // Same reasoning as the reopen branch: stamp it so a later
        // independent stale-fallback check doesn't redundantly reprocess
        // content a human already had investigated directly.
        record.checkedThroughAt = messages.reduce((max, m) => Math.max(max, m.timestamp ?? 0), record.checkedThroughAt ?? 0);
        if (result.repo) {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          manualEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: manual "!tg-autopilot investigate" note -> escalated to ${result.repo}`);
        } else {
          skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: result.unmappedKey });
        }
      } else if (isReopen && !reopenHasNothingNew) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript);
        recordScan("reopen", accountKey, conversation.session_id, result);
        if (result.repo && result.actionable && result.kind !== "none") {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          reopenEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: reopened after resolve, classifier agrees -> escalated to ${result.repo}`);
        } else {
          // Log the verdict even on a skip, so a silently-missed real bug is visible in the run log.
          console.log(`[${accountKey}] ${conversation.session_id}: reopened after resolve, classifier says not actionable (kind=${result.kind ?? "n/a"}${result.repo ? "" : ", unmapped"}) -- not escalated`);
        }
        // Advance the marker so an unresolved reopen doesn't get re-classified next run.
        const newestMs = newestTextTimestamp(messages, previousResolveAt);
        resolvedSeen[conversation.session_id] = newestMs;
        // Also stamp checkedThroughAt: if this later goes quiet again and
        // falls to the stale-fallback branch below with nothing further to
        // say, it should see this content as already handled, not re-classify it.
        record.checkedThroughAt = newestMs;
      } else if (eligibleForAutoEscalate) {
        // checkedThroughAt is stamped from the actual fetched messages, not
        // conversation-level metadata (see the note above on why) -- so a
        // conversation only gets re-classified once real new content shows
        // up, but can never be blocked forever the way a permanent
        // already-investigated flag was (confirmed for real: session_2fc63232
        // stayed stuck across repeated resolve/reopen cycles).
        const newestMessageAt = newestTextTimestamp(messages);
        if (record.checkedThroughAt === undefined || newestMessageAt > record.checkedThroughAt) {
          const result = await classifyAndRoute(accountConfig, conversation, transcript);
          recordScan("stale", accountKey, conversation.session_id, result);
          record.checkedThroughAt = newestMessageAt;
          if (result.repo && result.actionable && result.kind !== "none") {
            matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
            investigated.add(conversation.session_id);
            autoEscalations++;
            console.log(`[${accountKey}] ${conversation.session_id}: stale ${staleHours.toFixed(1)}h, classifier agrees -> escalated to ${result.repo}`);
          } else {
            console.log(`[${accountKey}] ${conversation.session_id}: stale ${staleHours.toFixed(1)}h, classifier says not actionable (kind=${result.kind ?? "n/a"}${result.repo ? "" : ", unmapped"}) -- not escalated`);
          }
        }
      }

      escalated[conversation.session_id] = record;
    }
  }

  // Both loops can claim the same session_id in one run -- dedupe, keep the first.
  const seenSessionIds = new Set();
  const dedupedMatrix = matrix.filter((entry) => {
    if (seenSessionIds.has(entry.session_id)) return false;
    seenSessionIds.add(entry.session_id);
    return true;
  });
  const duplicatesRemoved = matrix.length - dedupedMatrix.length;

  await writeFile("matrix.json", JSON.stringify(dedupedMatrix));
  // If any resolved conversation was skipped (rate limit), keep the old cursor
  // so it's refetched next run instead of falling out of the window.
  if (resolvedFetchSkipped > 0) {
    console.warn(`${resolvedFetchSkipped} resolved conversation(s) skipped due to rate limiting; cursor not advanced`);
  } else {
    await writeFile("state/cursor.json", JSON.stringify({ last_checked: runStartedAt }, null, 2) + "\n");
  }
  await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");
  // Bound growth, same as active-notified.json.
  await writeFile("state/investigated.json", JSON.stringify([...investigated].slice(-2000)));
  await writeFile(
    "state/resolved-seen.json",
    JSON.stringify(Object.fromEntries(Object.entries(resolvedSeen).slice(-5000)), null, 2) + "\n"
  );

  // Best-effort; never throws and no-ops unless EVENTS_REPO/EVENTS_TOKEN are set.
  await emitEvent("scan", {
    trigger: process.env.GITHUB_EVENT_NAME ?? null,
    started_at: runStartedAt,
    ended_at: new Date().toISOString(),
    totals: {
      fetched_resolved: totalFetched,
      already_handled: alreadyHandled,
      escalated: dedupedMatrix.length,
      // From scanRecords, not skippedUnmapped: that list only covers manual-note cases.
      unmapped: scanRecords.filter((r) => r.reason === "unmapped").length,
    },
    conversations: scanRecords,
  });

  if (GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Crisp triage — Stage 1`,
      ``,
      `Fetched (resolved, recorded as seen, not investigated): ${totalFetched} · Actionable: ${dedupedMatrix.length} · Unmapped (skipped): ${skippedUnmapped.length} · Already handled while active (skipped): ${alreadyHandled}${duplicatesRemoved ? ` · Duplicate session_id across loops (deduped): ${duplicatesRemoved}` : ""}`,
      `Escalated from active: ${manualEscalations} manual, ${reopenEscalations} reopen-after-resolve, ${autoEscalations} stale-auto (${AUTO_ESCALATE_HOURS}h–${AUTO_ESCALATE_MAX_HOURS}h)`,
    ];
    if (escalatedRows.length) {
      lines.push(``, `| Crisp conversation | Repo | Kind | Via | Confidence |`, `| --- | --- | --- | --- | --- |`);
      for (const r of escalatedRows) {
        lines.push(`| [open in Crisp](${r.url}) | ${r.repo} | ${r.kind} | ${r.path} | ${r.confidence == null ? (r.path === "manual note" ? "n/a (human call)" : "n/a") : `${r.confidence}/100`} |`);
      }
    }
    if (skippedUnmapped.length) {
      lines.push(``, `Unmapped inbox keys / unidentified products seen (add these to config/inbox-to-repo.json if real):`);
      for (const s of skippedUnmapped) lines.push(`- [${s.account}] \`${s.inboxKey}\` (session ${s.session_id})`);
    }
    await writeFile(GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
