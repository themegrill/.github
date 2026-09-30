# Changelog

Dated entries for notable fixes, redesigns, and policy changes to the bot. See `SETUP.md` (Phase 1: pr-build-zip) and `PHASE2-SETUP.md` (Phase 2: Crisp triage) for the design rationale these entries reference.

## 2026-09-30 — maintainability pass

- Added root `CLAUDE.md` indexing `.claude/skills/`, the doc split, and the hard-won rules below — none of this was being discovered by an agent working from a fresh clone instead of a checkout with `.claude/` loaded, which is exactly how the 2026-09-29 PR #93 mistake happened in the first place.
- Split the changelog out of `PHASE2-SETUP.md` into this file.
- Added `debug-crisp-triage-not-investigated` skill (the elimination checklist from the 2026-09-29 investigations, so a future "why didn't this fire" question doesn't start from zero).
- Extended `verify-github-actions-change` with the stale-branch-name lesson from PR #93.
- Removed 3 temporary diagnostic scripts (`diagnose-active-cap.mjs`, `diagnose-conversation-state.mjs`, `diagnose-message-timestamps.mjs`) and their workflow, left on master from the 2026-09-29 investigations and missed in that day's own cleanup pass — caught while reviewing `scripts/` for this same maintainability work, not before.
- Corrected `PHASE2-SETUP.md`'s file listing: `state/investigated.json`'s description still said it gates re-investigation, which stopped being true the moment `checkedThroughAt` shipped. `state/escalated.json` (the one that actually matters now) wasn't listed there at all.

## 2026-09-29 — permanent-block bug fix, real-timestamp freshness, cron/debug tooling, QA labels

Two real chat sessions (`session_2fc63232`, `session_bd0acc7b`) stopped producing issues despite genuine, never-addressed problems. Root cause and fix:

- `investigated.has(session_id)` / `escalated[session_id].autoEscalated` were permanent flags that never cleared, so a session auto-escalated once could never be auto-escalated again, ever — even after resolving and reopening with a brand new problem weeks later. Replaced with `checkedThroughAt` (timestamp from real fetched messages, not conversation metadata) — see § 4c of `PHASE2-SETUP.md`.
- A reopen with nothing new since a (possibly spurious) resolve took the reopen branch, found an empty delta, and skipped forever instead of falling through to the independently-stale check. Now falls back to a full-history stale check.
- Along the way, confirmed `active.last`/`updated_at` can lag real message activity for at least some conversations — the reason `checkedThroughAt` is deliberately message-based, not metadata-based. The 12h–720h staleness *window* itself still uses that metadata and is a known, unfixed residual gap (see the ⚠️ warning in `PHASE2-SETUP.md` § 4c).
- `seed-escalated.mjs` had the same metadata-vs-real-timestamp bug on first attempt (seeded from `updated_at`, which undercounted real activity for a large fraction of a backlog and caused it to immediately re-fire) — fixed to fetch real messages instead, and given a `--force` flag to recompute existing entries.
- All 3 accounts' current backlog was re-seeded with real-timestamp `checkedThroughAt` on 2026-09-29, so this fix applies to new activity going forward rather than re-litigating months of history in one burst.
- Added `skip_dedupe_check` (workflow_dispatch input on `crisp-triage.yml`) to skip the slow "check active conversations for duplicates" step (~15–20 min, unrelated to classify logic) for fast manual debugging. **Caveat learned the hard way: if `matrix` isn't empty, the downstream `investigate` job still auto-fires immediately after classify finishes** — a "fast test" run isn't safe to leave unattended once real conversations match, and must be watched/cancelled if you don't want real issues filed.
- Added `manual-qa-required`/`qa-verified` labels to AI-filed issues, decided per-item from the agent's own confidence score and reproduction method (see `prompts/crisp-triage-agent.md`). In practice, almost everything lands on `manual-qa-required` — this pipeline only has the target repo checked out, no live WordPress site to actually execute against, so genuine direct reproduction is the exception, not the rule.
- Cron cadence changed several times this session while chasing a real multi-day pattern of scheduled runs silently not firing (no error, no run object — confirmed not a billing/budget block by checking actual usage data; still unconfirmed root cause). Settled on `17 */3 * * *` (offset off the exact hour, a documented mitigation, not a proven fix) as of this writing.
- Found (not yet fixed): `crisp-dedupe-active.mjs` has no freshness gate at all — it re-runs a real OpenAI call for every still-open, still-unmatched conversation on every single run, forever, for as long as it stays open. Same class of bug as the `checkedThroughAt` fix above, just not yet applied here. Also calls `listOpenIssues(repo)` once per conversation instead of once per repo per run.

PRs: themegrill/.github#91, #92 (superseded, see below), #93 (accidentally a no-op — opened from a stale branch, merge commit had zero file changes; see the `verify-github-actions-change` skill for the lesson), #94, #95 (the real fix), #96, #97 (QA labels), #98 (cron + docs), #99 (cron offset).
