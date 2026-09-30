# tg-autopilot (themegrill/.github)

This repo hosts ThemeGrill's shared bot automation: reusable GitHub Actions workflows (PR build-zip, Copilot review) and the Crisp → AI → GitHub issue triage pipeline. Machine user: `tg-autopilot`.

**Before doing anything here, check `skills/` first (plugin `tg-autopilot`; skills show up as `tg-autopilot:<name>`).** There is very likely already a skill covering the task — onboarding a repo, debugging a specific failure mode, verifying a change actually took effect. Re-deriving one of these from scratch instead of using the existing skill is exactly how repeat mistakes happen; see `CHANGELOG.md` 2026-09-29 for one that cost real debugging time.

**Work from a persistent local checkout, not a disposable clone.** A fresh `git clone` into a scratch directory (e.g. `/tmp`) never has the `tg-autopilot` plugin loaded, which defeats the point of this file and everything below it.

## Map

- `ARCHITECTURE.md` — diagrams of how the three pipelines and each script fit together; start here if you are new.
- `SETUP.md` — Phase 1 (pr-build-zip, Copilot review): one-time credentials/setup.
- `PHASE2-SETUP.md` — Phase 2 (Crisp triage): credentials/setup **and** the actual design policy — § 4c/4d explain what triggers an investigation and why, and are the first thing to read before touching `crisp-classify.mjs`.
- `CHANGELOG.md` — dated entries for notable fixes/redesigns. Read the most recent entries before assuming you understand current behavior; policy here has changed more than once.
- `skills/` — task- and symptom-oriented playbooks (onboarding, debugging, verification). Check this before improvising.
- `scripts/` — all Node scripts, most with dense "why" comments at the point of the actual gotcha, not just a docstring at the top. Read the comment before changing the line it's attached to.
- `state/` — committed JSON state (`cursor.json`, `escalated.json`, `resolved-seen.json`, `investigated.json`, `active-notified.json`). These are data, not config — don't hand-edit without understanding what reads them first.
- `config/inbox-to-repo.json` — Crisp account → GitHub repo routing.
- `prompts/crisp-triage-agent.md` — the Stage 2 investigation agent's actual instructions.

## Hard-won rules, worth repeating

- **Verify a pushed branch's actual remote content** (`gh api repos/OWNER/REPO/contents/PATH?ref=BRANCH`) before opening a PR from it — a stale local branch with the same name as an earlier, already-merged one can silently absorb your push instead of your new commits. This produced a real no-op PR (#93) that looked merged and normal until someone checked the diff.
- **A "fast test" dispatch of `crisp-triage.yml` (`skip_dedupe_check: true`) is not safe to leave unattended** if you're not sure the matrix will be empty — the `investigate` job auto-fires immediately after classify finishes, checking out real repos and potentially filing real issues. Check the classify step's log for `-> escalated to` lines before walking away.
- **`gh api`/`gh` can serve a cached response for a `GET` shortly after a mutation you just made** — see the `verify-github-actions-change` skill.
- Conversation-level metadata (`active.last`, `updated_at`) can lag real message activity — confirmed for real on at least one email-origin conversation. Any "has something new happened?" check in this codebase should be based on actual fetched message timestamps, never on this metadata alone (see `PHASE2-SETUP.md` § 4c's ⚠️ warning).
