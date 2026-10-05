# Changelog

Short, dated summary of notable fixes and changes. For the full "why," see `PHASE2-SETUP.md` (Crisp triage design) or the linked PRs.

## 2026-10-05 — stopped conversations being re-investigated by their own notes

A conversation (e.g. `session_bd0acc7b`) was investigated again every few hours with no new customer activity.

- **Root cause**: the stale and reopen paths stamped `checkedThroughAt` / `resolved-seen` from the newest message of *any* type. Stage 2 posts its private note after that stamp, so the next run saw the bot's own note as "new activity", re-classified the unchanged transcript, and re-investigated. The note dedupe only keys on GitHub issue URLs, so "no bug / how-to" notes were posted again each time.
- **Fix**: those two paths now take the newest timestamp from `type: "text"` messages only (`newestTextTimestamp` in `crisp-classify.mjs`). Manual `!tg-autopilot investigate` branches and `crisp-investigate-now` are unchanged.
- Existing stored markers are equal or newer than the text-only value, so nothing re-fires on deploy.
- Not changed: `crisp-post-note.mjs` dedupe for URL-less notes, the GitHub-comment check (prompt-only), and `crisp-dedupe-active.mjs`.

## 2026-10-02 — event log for a triage dashboard (not live until the data repo exists)

Groundwork for a run dashboard: Stage 1 and Stage 2 now write small JSON events to a **separate private repo** (`EVENTS_REPO`), never to this public one.

- `scripts/events.mjs` writes one file per event through the Contents API. Best-effort: failures only warn, and with `EVENTS_REPO` unset it does nothing, so it is safe to merge first.
- Two event types: `scan` (one per classify run, one entry per conversation that reached the classifier, with its tokens/cost) and `investigation` (one per Stage 2 job: status, outcome, issues filed/tracked, agent cost and duration).
- No customer text in events: ids, enums, links, counts and costs only. The outcome is read from the bullet lines of the mandated Crisp note, never its free-text summary.
- The events token is written in a separate workflow step, not in the agent's environment; the agent only leaves a copy of its note at `NOTE_RECORD_PATH`.
- `scripts/build-dashboard.mjs` turns the event files into one self-contained HTML dashboard (`node scripts/build-dashboard.mjs <data-repo-checkout>/events out.html`). Manual for now; nothing rebuilds or hosts it automatically yet.
- "Linked" and "commented on a match" can't be told apart from the note, so both show as `tracked`.
- Classifier cost is estimated from token counts via `scripts/pricing.mjs` (verify prices; unknown model = no cost). Agent token counts assume opencode's `step_finish.part.tokens` shape and come back null if absent. Neither is confirmed against a real run yet.

## 2026-09-30 — housekeeping

- Added `CLAUDE.md` so future work here starts from the existing skills/docs instead of re-discovering things from scratch.
- Split this changelog out of `PHASE2-SETUP.md` into its own file.
- Added a skill for debugging "why wasn't this conversation investigated."
- Removed 3 leftover debug scripts that should've been cleaned up on 09-29.
- Fixed a couple of outdated file descriptions in `PHASE2-SETUP.md`.

PR: #100

## 2026-09-29 — fixed conversations getting permanently stuck

Some conversations stopped getting investigated at all, even with new, real problems.

- **Root cause**: once a conversation was checked, it could never be auto-checked again — a one-way flag, no way to reset it.
- **Fix**: now tracks the actual last-seen message time instead, so it re-checks whenever something genuinely new comes in.
- Also fixed: a reopened conversation with nothing new in it used to get skipped entirely, instead of still being checked for staleness.
- Re-seeded all 3 Crisp accounts so this fix applies going forward, not to the whole backlog at once.
- Added `manual-qa-required` / `qa-verified` labels on AI-filed issues.
- Added a quick-test mode for `crisp-triage` (skips the slow duplicate-check step).
- Nudged the schedule off the exact hour (`17 */3 * * *`) — scheduled runs were silently not firing; this is a likely mitigation, not a confirmed fix.
- Known remaining issue: the duplicate-check script has no "don't recheck if nothing changed" logic yet, so it re-runs OpenAI checks on the same conversations every time. Not fixed yet.

PRs: #91, #92 (superseded), #93 (accidental no-op, see the `verify-github-actions-change` skill), #94, #95 (the real fix), #96, #97, #98, #99
