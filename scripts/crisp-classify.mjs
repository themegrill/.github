#!/usr/bin/env node
// Stage 1 of the Crisp -> AI -> GitHub issue pipeline.
//
// Policy: a resolved conversation is trusted as fully handled by support --
// resolving it (first time or Nth time) never triggers investigation on its
// own. The only way a previously-resolved conversation gets investigated is
// if it reopens (goes active again) before its next resolve; the resolved-
// conversation loop below only records "seen resolved at T", and the
// active-conversation loop investigates a reopen using messages after T. If
// it gets resolved again before we ever see it active in between, it's
// never investigated at all -- that falls out naturally from this loop
// always just re-recording the (later) resolve time, no special-casing
// needed. See PHASE2-SETUP.md § 4c for the auto-escalation policy for
// conversations that were never resolved in the first place, and the manual
// "!tg-autopilot investigate" note, which always overrides all of this.
//
// Writes matrix.json (Stage 2's input), state/cursor.json,
// state/escalated.json, and state/resolved-seen.json (per-session
// bookkeeping so none of the above repeats itself).
//
// Provider: OpenAI, swappable freely. Verify CLASSIFY_MODEL against your
// account before relying on it.
import { readFile, writeFile } from "node:fs/promises";
import {
  fetchResolvedConversationsSince,
  fetchActiveConversations,
  searchConversationsForManualTrigger,
  fetchRawMessages,
  countManualTriggerNotes,
  credsForAccount,
} from "./crisp-client.mjs";
import { classifyAndRoute } from "./crisp-classifier.mjs";

const { GITHUB_STEP_SUMMARY } = process.env;
const AUTO_ESCALATE_HOURS = 12;
const AUTO_ESCALATE_MAX_HOURS = 24 * 30; // past this, only a manual note escalates it

function transcriptFrom(messages) {
  return messages
    .filter((m) => m.type === "text")
    .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const cursor = JSON.parse(await readFile("state/cursor.json", "utf8"));
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;
  // Skip anything the active-conversation dedupe check already matched to a
  // tracked issue, to avoid a second redundant comment.
  const activeNotified = new Set(
    JSON.parse(await readFile("state/active-notified.json", "utf8").catch(() => "[]"))
  );
  // { [session_id]: { autoEscalated: bool, manualNoteCount: number } }
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));
  // session_ids already fully investigated once (any path) -- prevents a
  // resolve/reopen/resolve cycle from reinvestigating forever. Not checked
  // on the manual-note path; that's an intentional re-trigger.
  const investigated = new Set(
    JSON.parse(await readFile("state/investigated.json", "utf8").catch(() => "[]"))
  );
  // { [session_id]: <ms timestamp of the last time we saw it resolved> } --
  // the only signal that lets the active loop below recognize a reopen.
  const resolvedSeen = JSON.parse(await readFile("state/resolved-seen.json", "utf8").catch(() => "{}"));

  const matrix = [];
  const skippedUnmapped = [];
  let alreadyHandled = 0;
  let totalFetched = 0;
  let manualEscalations = 0;
  let autoEscalations = 0;
  let reopenEscalations = 0;

  // Each Crisp account (different logins) is fetched/classified independently;
  // one not yet credentialed is skipped with a warning, not a crash.
  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch (err) {
      console.warn(`[${accountKey}] skipping: ${err.message}`);
      continue;
    }

    // ---- Resolved conversations: record as seen, never investigate here ----
    // except for an explicit manual note, which always overrides the policy.
    const conversations = await fetchResolvedConversationsSince(creds, cursor.last_checked);
    totalFetched += conversations.length;
    console.log(`[${accountKey}] fetched ${conversations.length} resolved conversations since ${cursor.last_checked}`);

    for (const conversation of conversations) {
      if (activeNotified.has(conversation.session_id)) {
        alreadyHandled++;
        continue;
      }

      // Fetch raw messages (not just the transcript) so a manual note can be
      // counted below without a second Crisp call.
      const messages = await fetchRawMessages(creds, conversation.session_id);
      const transcript = transcriptFrom(messages);

      if (transcript.trim()) {
        const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };
        const manualNoteCount = countManualTriggerNotes(messages);
        const hasNewManualNote = manualNoteCount > record.manualNoteCount;

        if (hasNewManualNote) {
          const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
          record.manualNoteCount = manualNoteCount;
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

      // Record every resolved conversation as seen, regardless of the
      // manual-note branch above -- a later reopen is measured from
      // whichever resolve happened most recently.
      resolvedSeen[conversation.session_id] = conversation.updated_at ?? Date.now();
    }

    // ---- Active conversations: manual note, reopen, and time-based escalation ----
    // Independent of crisp-dedupe-active.mjs, which skips anything that
    // ends up in matrix.json this run.
    //
    // Only fetch messages for conversations touched since cursor.last_checked
    // (adding a note is itself an update) -- cheaper than fetching every
    // active conversation's history. Staleness/reopen detection need no
    // message fetch at all.
    const lastCheckedMs = new Date(cursor.last_checked).getTime();
    const activeConversations = await fetchActiveConversations(creds);
    activeConversations.forEach((conversation) => {
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      conversation._checkManualNote = lastActiveAt > lastCheckedMs;
    });

    // fetchActiveConversations' page cap can bury a manually-noted
    // conversation on a high-volume account -- search directly for the
    // trigger phrase so a manual note is never missed. Anything found only
    // here is appended and always checked this run.
    const seenSessionIds = new Set(activeConversations.map((c) => c.session_id));
    const manualTriggerHits = await searchConversationsForManualTrigger(creds, "!tg-autopilot investigate");
    for (const hit of manualTriggerHits) {
      if (seenSessionIds.has(hit.session_id)) continue;
      hit._checkManualNote = true;
      activeConversations.push(hit);
      seenSessionIds.add(hit.session_id);
    }

    for (const conversation of activeConversations) {
      const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };
      const previousResolveAt = resolvedSeen[conversation.session_id];

      // active.last, not created_at: a reopened thread gets a fresh grace
      // period rather than reading as ancient. Pure metadata, no message fetch.
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      const staleHours = (Date.now() - lastActiveAt) / (1000 * 60 * 60);
      const eligibleForAutoEscalate =
        !record.autoEscalated &&
        !investigated.has(conversation.session_id) &&
        staleHours >= AUTO_ESCALATE_HOURS &&
        staleHours <= AUTO_ESCALATE_MAX_HOURS;

      // Previously seen resolved, now active again -- a reopen. Checked
      // regardless of staleness/manual note: if it resolves again before we
      // ever catch it here, the resolved-conversation loop above just
      // records the later resolve time and this never fires for that gap.
      const isReopen = previousResolveAt !== undefined;

      if (!conversation._checkManualNote && !eligibleForAutoEscalate && !isReopen) continue;

      const messages = await fetchRawMessages(creds, conversation.session_id);
      const manualNoteCount = conversation._checkManualNote ? countManualTriggerNotes(messages) : record.manualNoteCount;
      const hasNewManualNote = manualNoteCount > record.manualNoteCount;

      if (!hasNewManualNote && !eligibleForAutoEscalate && !isReopen) continue;

      // A reopen only looks at what's new since the previous resolve (a
      // manual note overrides this and always gets the full transcript, same
      // as everywhere else this pipeline honors that note).
      const relevantMessages = isReopen && !hasNewManualNote
        ? messages.filter((m) => (m.timestamp ?? 0) > previousResolveAt)
        : messages;
      const transcript = transcriptFrom(relevantMessages);
      if (!transcript.trim()) continue;

      if (hasNewManualNote) {
        // No investigated guard -- a manual re-trigger should always go through.
        const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
        record.manualNoteCount = manualNoteCount;
        if (result.repo) {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          manualEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: manual "!tg-autopilot investigate" note -> escalated to ${result.repo}`);
        } else {
          skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: result.unmappedKey });
        }
      } else if (isReopen) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript);
        if (result.repo && result.actionable && result.kind !== "none") {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          reopenEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: reopened after resolve, classifier agrees -> escalated to ${result.repo}`);
        }
        // Advance the marker to the newest message we just looked at, so a
        // conversation that's still open (not yet resolved again) doesn't
        // get the same content re-classified on the next run.
        const newestMs = messages.reduce((max, m) => Math.max(max, m.timestamp ?? 0), previousResolveAt);
        resolvedSeen[conversation.session_id] = newestMs;
      } else if (eligibleForAutoEscalate) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript);
        record.autoEscalated = true; // fires at most once, whether actionable or not
        if (result.repo && result.actionable && result.kind !== "none") {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          autoEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: stale ${staleHours.toFixed(1)}h, classifier agrees -> escalated to ${result.repo}`);
        }
      }

      escalated[conversation.session_id] = record;
    }
  }

  // Both loops can claim the same session_id in one run (e.g. a manual note
  // reopens a just-resolved conversation). Dedupe, keeping the first entry seen.
  const seenSessionIds = new Set();
  const dedupedMatrix = matrix.filter((entry) => {
    if (seenSessionIds.has(entry.session_id)) return false;
    seenSessionIds.add(entry.session_id);
    return true;
  });
  const duplicatesRemoved = matrix.length - dedupedMatrix.length;

  await writeFile("matrix.json", JSON.stringify(dedupedMatrix));
  await writeFile("state/cursor.json", JSON.stringify({ last_checked: runStartedAt }, null, 2) + "\n");
  await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");
  // Bound growth, same as active-notified.json.
  await writeFile("state/investigated.json", JSON.stringify([...investigated].slice(-2000)));
  await writeFile(
    "state/resolved-seen.json",
    JSON.stringify(Object.fromEntries(Object.entries(resolvedSeen).slice(-5000)), null, 2) + "\n"
  );

  if (GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Crisp triage — Stage 1`,
      ``,
      `Fetched (resolved, recorded as seen, not investigated): ${totalFetched} · Actionable: ${dedupedMatrix.length} · Unmapped (skipped): ${skippedUnmapped.length} · Already handled while active (skipped): ${alreadyHandled}${duplicatesRemoved ? ` · Duplicate session_id across loops (deduped): ${duplicatesRemoved}` : ""}`,
      `Escalated from active: ${manualEscalations} manual, ${reopenEscalations} reopen-after-resolve, ${autoEscalations} stale-auto (${AUTO_ESCALATE_HOURS}h–${AUTO_ESCALATE_MAX_HOURS}h)`,
    ];
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
