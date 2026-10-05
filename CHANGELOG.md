# Changelog

Short, dated summary of notable fixes and changes. For the full "why," see `PHASE2-SETUP.md` (Crisp triage design) or the linked PRs.

## 2026-10-05 — root-cause category and draft customer reply in the Stage 2 note

- The agent now classifies each reported problem as `product_bug`, `conflict`, `host`, or `user_error` (or `undetermined` when evidence is insufficient, `not_applicable` for feature-request-only) and cites evidence. **Only `product_bug` may be filed or commented on in GitHub**; the other categories get only the Crisp note. Feature-request handling is unchanged.
- The note gains `- Category:` / `- Evidence:` bullets and a `=== DRAFT REPLY ... === END DRAFT ===` block: a plain-language customer reply for staff to edit and send. The bot still never messages the customer.
- `events-parse.mjs`: new `parseCategory` (enum only; evidence and draft text never reach the event log); the investigation event gains a `category` field. Older notes without a Category line parse as `unknown`, never throw. `parseNote` ignores everything from the draft marker on.
- `crisp-post-note.mjs` only prints warnings for a missing category/draft, a non-`product_bug` note that reports a filed bug, or a draft containing URLs/issue numbers/file paths. It never blocks the post, so the "agent must leave a note" failure check is unchanged. Issue-URL dedupe ignores the draft block.
- `undetermined` is a fifth value beyond the four requested; it is how "evidence is insufficient" is expressed, and it files nothing (consistent with the existing "cannot substantiate" rule).
- Named `product_bug`, not `plugin_bug`: most repos here are themes (a first real run on `colormag-pro` was labeled `plugin_bug`). `parseCategory` still maps the old `plugin_bug` to `product_bug`. Evidence must show the cause, not just related code; hedged wording ("can break") means `undetermined`.
- Note readability: the prompt now caps the summary, evidence and draft length and layout; `crisp-post-note.mjs` collapses runs of blank lines.
- `crisp-post-note.mjs`: when every referenced issue was already noted earlier but the conversation never received a draft, it posts ONE reduced note (category, evidence, draft, no issue link) instead of skipping; once any note on the conversation carries a draft, the old skip applies again.
- Stage 2 default model is now `gpt-5.4-mini` (was `gpt-5-mini`), set both as the workflow fallback and as the `INVESTIGATE_MODEL` repo variable. Reason: on the first real ticket `gpt-5-mini` labeled a weakly evidenced case `product_bug`; `gpt-5.4-mini` answered `undetermined`. Cost is about 2.7x per investigation (about $0.07 vs $0.026). To revert: delete the variable and set the workflow fallback back. `crisp-investigate-now` also takes an optional per-run `model` input for testing.
- First real run (`crisp-investigate-now` from the branch) confirmed the flow end to end; the note format was then tightened as above.

## 2026-10-05 — triage schedule 3h -> 4h

Measured the last 30 scheduled runs: gaps were never a steady 3h (median ~6.5h, up to 12h) because GitHub silently drops/delays scheduled runs. Changed cron to `17 */4 * * *` per request. This lowers the nominal frequency; it does not fix the dropped runs.

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
