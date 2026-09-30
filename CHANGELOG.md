# Changelog

Short, dated summary of notable fixes and changes. For the full "why," see `PHASE2-SETUP.md` (Crisp triage design) or the linked PRs.

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
