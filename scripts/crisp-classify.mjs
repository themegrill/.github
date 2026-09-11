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
  // Avoid a redundant comment for anything the dedupe check already matched.
  const activeNotified = new Set(
    JSON.parse(await readFile("state/active-notified.json", "utf8").catch(() => "[]"))
  );
  // { [session_id]: { autoEscalated: bool, manualNoteCount: number } }
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
      const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };
      const previousResolveAt = resolvedSeen[conversation.session_id];

      // active.last, not created_at, so a reopened thread isn't read as ancient.
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      const staleHours = (Date.now() - lastActiveAt) / (1000 * 60 * 60);
      const eligibleForAutoEscalate =
        !record.autoEscalated &&
        !investigated.has(conversation.session_id) &&
        staleHours >= AUTO_ESCALATE_HOURS &&
        staleHours <= AUTO_ESCALATE_MAX_HOURS;

      // Seen resolved before, active again now -- a reopen.
      const isReopen = previousResolveAt !== undefined;

      if (!conversation._checkManualNote && !eligibleForAutoEscalate && !isReopen) continue;

      const messages = await fetchRawMessages(creds, conversation.session_id);
      const manualNoteCount = conversation._checkManualNote ? countManualTriggerNotes(messages) : record.manualNoteCount;
      const hasNewManualNote = manualNoteCount > record.manualNoteCount;

      if (!hasNewManualNote && !eligibleForAutoEscalate && !isReopen) continue;

      // A reopen only sees what's new since the previous resolve; a manual note gets everything.
      const relevantMessages = isReopen && !hasNewManualNote
        ? messages.filter((m) => (m.timestamp ?? 0) > previousResolveAt)
        : messages;
      const transcript = transcriptFrom(relevantMessages);
      if (!transcript.trim()) continue;

      if (hasNewManualNote) {
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
        // Advance the marker so an unresolved reopen doesn't get re-classified next run.
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

  // Both loops can claim the same session_id in one run -- dedupe, keep the first.
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
