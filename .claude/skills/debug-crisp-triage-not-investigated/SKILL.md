---
name: debug-crisp-triage-not-investigated
description: Diagnose why a specific Crisp conversation was never auto-investigated (no issue filed, no note posted), working through real confirmed causes in order instead of guessing.
---

# Debug "why wasn't this conversation investigated"

Three real, distinct root causes have each separately explained this symptom during actual investigations. Don't assume it's whichever one you found last time — work through these in order, checking state directly rather than reasoning from code alone.

## 0. First, get the facts, not a theory

For the session_id in question, pull the relevant state directly:

```
# search state/resolved-seen.json, state/investigated.json, state/escalated.json for the session_id
```

And get its *current live state* from Crisp directly (a temporary read-only `workflow_dispatch` diagnostic, deleted after use — see `verify-github-actions-change` skill's pattern for building one safely). Fetch the conversation object (`state`, `created_at`, `updated_at`, `active.last`) — **never** dump raw message content/sender identity into a workflow log; that's a real PII boundary, confirmed blocked once already. Timestamps and `type` only, if you need message-level data at all.

## Elimination checklist (each confirmed real, on a different session, in the same investigation)

1. **Is it actually past `AUTO_ESCALATE_MAX_HOURS` (30 days)?** Compute hours since `created_at`. If it's genuinely older than 720h and was never resolved, this is *working as designed* — "past this, only a manual note escalates it" is a deliberate policy, not a bug. (`session_2fc63232`, once its `checkedThroughAt` reset correctly, still didn't fire because it had aged past this window in the meantime.)
2. **Was it permanently blocked by a stale flag?** Pre-2026-09-29, `investigated.has(session_id)` and `escalated[session_id].autoEscalated` were permanent once set, with no reset. If you're reading this after that fix, this specific cause shouldn't recur — but if `checkedThroughAt` looks like it should have re-armed and didn't, that's a regression worth treating seriously, not shrugging off.
3. **Did a resolve/reopen cycle mask an independent staleness check?** If `state/resolved-seen.json` has an entry for this session (`isReopen` would be true) and the reopen delta was empty (nothing new since that resolve), confirm the fallback to a full-history stale check actually fired — check for a `stale ... classifier says` log line, not just a `reopened after resolve` one. If neither log line exists at all for recent runs, it may have fallen outside the active-conversation page cap (200/account) — check its rank directly rather than assuming (`session_bd0acc7b` was rank 12; a different real case that hit the cap was confirmed on `THEMEGRILL` specifically).
4. **Does the screenshot you're comparing against actually match this session_id?** Cross-check the exact `session_id` in the URL before trusting a customer/team screenshot's content against your state-file findings — a mismatched screenshot sent an entire investigation down the wrong path once (confused a different, unrelated conversation's real content for this one's, which had a much shorter, quieter real history).
5. **Was it a genuine metadata lag, not a bug?** `active.last`/`updated_at` can lag real message timestamps — confirmed for real on at least one email-origin conversation. If the state file's timestamp looks "too old" compared to what a human says actually happened, this is the most likely explanation, and no code fix resolves it except computing freshness from real message timestamps directly (which `checkedThroughAt` now does, post-2026-09-29).

## What forces an answer right now, regardless of root cause

`crisp-investigate-now.yml` (`workflow_dispatch`, input = session_id) bypasses every guard above entirely — it always routes and investigates, with real side effects (may file a real issue, always posts a note). Use it once you've understood *why* the normal path didn't fire, not as a substitute for finding out.

## After finding the cause

If it points at a real code gap (not "working as designed" or "genuine metadata limitation"), fix the root cause in `crisp-classify.mjs`, not just this one session — and check whether `crisp-dedupe-active.mjs` or any other script shares the same class of bug before calling it done (as of 2026-09-29, it does: no freshness gate at all, a known but unfixed gap — see `CHANGELOG.md`).
