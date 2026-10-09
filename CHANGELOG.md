# Changelog

Short, dated summary of notable fixes and changes. For the full "why," see `PHASE2-SETUP.md` (Crisp triage design) or the linked PRs.

## 2026-10-09 — QA review: tuned, then put ON HOLD (read this before resuming)

**Status: on hold, manual dispatch only.** Nothing triggers it: no n8n flow, no org webhook. Deliberately not wired up (see "Why on hold").

What this change does to the review job (all verified against real runs on public `themegrill/user-registration` PRs #1428, #1393, #1392, `post_comment=false`):
- Findings are capped by change size in code (`limitsFor`): a one-line PR got 1 risk, 1 test and 3 scenarios before; now at most 1/2/1.
- Prompt: no "if X relies on Y" speculation, no repeating the PR's own test steps, tests must be about the same feature.
- Strict structured output (`REVIEW_FORMAT`; `chatJSONWithUsage` gained an optional 4th param, other callers unchanged). With loose JSON mode the model sometimes returned test suggestions without the `title` key, so 4-7 of them were discarded per run on #1392 and the comment looked empty (2 of 4 runs). Risks were never discarded in about 11 runs of that PR, so the `file:line` citations are reliable. Same PR, same model: results still vary run to run.
- The comment no longer says "none found" when the model raised risks that failed verification. Discard reasons are logged for PUBLIC target repos only (they quote model/PR text); the review itself goes to the job log/summary only for explicitly public repos, never private ones (this repo is public).
- Allowlist: added `themegrill/user-registration` (public; appears to be the same repo as `wpeverest/user-registration`, same PR numbers under both names). The `wpeverest` org token (`BOT_TOKEN`) gets 403 on the collaborator-permission lookup, so don't enroll repos by their `wpeverest/` name until that token is fixed.
- Measured: about 9-13k input and 0.3-0.8k output tokens per review on `gpt-5.4-mini`. No price row in `pricing.mjs`, so cost is unmeasured (roughly a cent by estimate).

### Why on hold
- The reviewer only reads the diff; it never runs the plugin. It overlaps Copilot (already auto-requested), `security-review.yml` and PHPCS, and its test suggestions point QA at cases they already know. On its own it does not save QA time or catch bugs that reviewers miss.
- `ThemeGrill/claudegrill` already runs real Playwright e2e on PRs (`pr / suite` check, `@claudegrill suite` to re-run), deterministic and with no AI key. Its agent tier (`pr-qa.yml`, `pr-command.yml`, skill `pr-qa-review`) is the closest thing to a QA agent that exists, but it runs Claude (needs `ANTHROPIC_API_KEY`, which this org does not use) and is deliberately switched off ("the team removed AI from the PR path"). Do not build a second e2e system next to it.

### If resumed
1. Spike locally first (no CI, nothing published): an OpenAI agent (`opencode`, as in the Crisp job) following a PR's "How to test" steps with Playwright against a site booted by claudegrill's `plugins/claudegrill/scripts/boot-wp.mjs` (Playground, pro licence supported). Candidate: `user-registration-pro#1610`. Judge verdicts on PRs where the right answer is known.
2. Only if that is trustworthy: run it in a PRIVATE repo, not here. This repo is public, so its logs and run summaries are public, and an agent working on a private repo's PR would publish that code. (One dry run already leaked a private-PR review into a public summary; the run was deleted and the code now withholds it.)
3. Then the trigger: org webhook -> n8n -> `repository_dispatch` into the private repo, reusing `qa-review-gate.mjs` (requester must have write access; the payload is untrusted). Use a dedicated spend-capped OpenAI key, not the shared one.
- Open items: the pro repo's `BOT_TOKEN_THEMEGRILL` PAT lacks "Checks: read" (the "other checks" line says "not available" there); `@claudegrill suite` triggers only for collaborators, and `tg-autopilot` is one.

## 2026-10-09 — QA review: advisory review job (step 2), scoped to complement existing checks

Found while inspecting the pilot repo (`user-registration-pro`): it already has PHPCS-on-PR (`pr-code-sniff.yml`), an AI security scan (`security-review.yml`), and `ThemeGrill/claudegrill`'s deterministic E2E suite with `.themegrill-qa/` test cases and knowledge. claudegrill's README says AI was deliberately removed from the PR path. So the original plan (own static tools + droplet WordPress sandbox) would have duplicated all of that, and was dropped for now. This bot is opt-in only (someone must request `tg-autopilot` as reviewer) and is scoped to what those checks don't do.

- New `review` job in `qa-review.yml`, after the gate. It never checks out or runs PR code: it reads the diff and the base branch's `.themegrill-qa/` (`suite.json` area map, `testcase-index.json` titles, `knowledge.md`) through the API, plus the other checks' results, and makes ONE model call (`prompts/qa-review.md`, default `gpt-5.4-mini`, override with the `QA_REVIEW_MODEL` repo variable).
- Output is one sticky advisory comment: summary, areas touched (deterministic, from `suite.json`), risks, existing test cases worth running by hand, and scenarios with no test case.
- Findings are verified, not trusted (see the CHANGELOG 2026-10-05 note on uncalibrated confidence): a risk is shown only if its `file:line` is an ADDED line in the diff; a suggested test only if its title exists verbatim in the index. Everything else is dropped and counted in the comment footer. No confidence number is shown. Model output is stripped of URLs, `@mentions`, HTML and backticks. An unparseable or empty model answer fails the job instead of posting "no risks found".
- Not verified yet against a real model call: output quality, and cost (`pricing.mjs` has no row for the default model, so cost shows only if you add one). Uses the shared `OPENAI_API_KEY`; a dedicated spend-capped key is advisable before n8n makes this fire automatically.
- Still manual dispatch only; no n8n flow or org webhook yet.
- **Privacy:** `themegrill/.github` is PUBLIC, so run summaries/logs are public. The first dry run wrote a review of a private-repo PR into a public run summary (one-line change; the run was deleted). The review body now goes to the run summary only when the target repo is explicitly public; for private repos it is posted to the PR only (`post_comment=true`). Never log or summarize review content, PR text or diffs from private repos in this repo's runs.
- The bot's fine-grained PAT cannot read check runs (403, needs "Checks: read"); that section is best-effort and says "not available" until the PAT is updated.

## 2026-10-09 — QA review: gate only (step 1 of a staged build, not a review yet)

First piece of a PR QA-review agent (request `tg-autopilot` as reviewer -> deep review). This change adds only the front half: `qa-review.yml` (`repository_dispatch: qa-review` or manual `workflow_dispatch`), `scripts/qa-review-gate.mjs` and `config/qa-review-repos.json` (allowlist; pilot is `themegrill/user-registration-pro` only).

- The gate re-verifies everything against the live API (the dispatch payload is untrusted): allowlisted repo, PR open and not a draft, same-repo (forks denied), `head_sha` current, requester is not the bot, requester has `write` or higher (triage is not enough, each review will spend LLM money). A wrong token identity (not `tg-autopilot`) fails the job rather than going silently green.
- `scripts/qa-review-comment.mjs` keeps ONE sticky PR comment, matched by bot login plus marker. Manual runs post nothing unless `post_comment` is true. The "accepted" comment is a placeholder and says no findings will follow.
- No n8n flow, org webhook, static checks, LLM review or droplet sandbox yet; the only way in is a manual dispatch. Not yet verified: that the real `BOT_TOKEN_THEMEGRILL` authenticates as `tg-autopilot` and can read the pilot repo.

## 2026-10-05 — wp.org triage files issues in the pro repo first

Issues now go to the product's `-pro` repo when it has one, otherwise to the free repo (`issue_repos` in `wporg/config/products.json`, replacing `fallback_repos`). The agent still reads the free repo's code and searches both repos for existing issues (Crisp files free-edition issues in the free repos, so a match can live there). The old "probe the free repo, fall back to pro" behavior is gone: the job now only checks that the token can write to the chosen issue repo and fails loudly if not (the topic is already marked seen, so re-run it by hand).

## 2026-10-05 — wp.org triage: filing threshold, closed-issue search, `wporg-forum` label

Interim policy after two false-positive issues on the same topic (#1243, #1244, both closed): the agent files only when its own confidence is above 50; below 70 or unreproduced it gets `manual-qa-required` (unchanged). Duplicate search now uses `--state all` so a match that a human already closed is not re-filed or commented on. Every filed issue also gets a `wporg-forum` label for bulk review, and the issue body gains a "Possible fix" section (suggestion only; "No fix proposed" when the diagnosis does not support one). Issues with confidence below 70 begin with a fixed "Low-confidence AI diagnosis -- verify manually" warning. Caveat: self-reported confidence is not calibrated (94 then 60 for the same wrong claim), so this does not stop a confidently wrong diagnosis; review the first issues by hand.

## 2026-10-05 — wp.org triage skips resolved topics

New topics already marked resolved on the forum are marked seen and not investigated (the marker is on the forum list page, not in the RSS feed, so each product costs one extra request). Re-open one with the manual dispatch. If the list page can't be read, nothing is treated as resolved. Checked against the live everest-forms list: 28 of 30 feed topics resolved, the 2 newest open.

## 2026-10-05 — wp.org triage: first filed issue was a false positive; prompt tightened

The first issue the pipeline filed (everest-forms phone flags, #1243 in the pro repo, now closed) blamed a non-existent stylesheet path. The agent stopped at the first mismatch: `register_styles()` registers the same handle with the correct path first and `enqueue_style()` skips re-registering, so the bad path is dead code. It also reported 94/100 confidence without reproducing anything, against a staff reply that they could not reproduce. The prompt now requires tracing every other registration/override of the same thing, and caps confidence at 60 unless the symptom was actually reproduced. Fallback to the pro repo and the report-in-log worked as intended on that run.

## 2026-10-05 — wp.org triage: pro-repo fallback, stricter completion check

Found on the first real run (`phone-field-country-flags-are-not-loading`, everest-forms): the agent concluded `product_bug` but "GitHub filing was blocked by repo permissions", and the job still went green.

- Likely cause: `BOT_TOKEN` is a fine-grained PAT limited to the repos it was granted; the free repos may not be among them. Not confirmed (the token can't be read). Fix at the source by adding the free repos to the PAT.
- Meanwhile the job probes write access and files in the `-pro` repo if the free repo is not writable (`fallback_repos` in `wporg/config/products.json`).
- Completion check now requires an actual tool call to `wporg-done.mjs` (the old filename grep also matched the prompt text), prints the agent's report to the job log, and uploads the raw agent output as an artifact. The tool-event shape it relies on is not yet confirmed against a real run.
- Prompt: a staff "could not reproduce" reply now counts against `product_bug`.

## 2026-10-05 — WordPress.org forum triage (new, self-contained in `wporg/`)

- New pipeline: new topics on each free plugin/theme's wp.org support forum are classified, then an agent files a GitHub issue or comments on an existing match. Triggered by n8n (`repository_dispatch` `wporg-triage`, every 12h); no `schedule:` on purpose.
- Lives in `wporg/` plus `wporg-triage.yml` / `wporg-investigate-job.yml`. No Crisp file, state or workflow was changed; only generic helpers (`openai-client`, `build-prompt`, `summarize-investigation`) are reused.
- Never posts to wordpress.org. First run per product only seeds existing topics. Public input is treated as untrusted in the prompt.
- Not yet run for real: first step is the n8n node plus a manual dispatch on one known topic. See `wporg/README.md`.

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
