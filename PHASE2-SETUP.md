# Phase 2 setup — Crisp → AI → GitHub issue

Files added for this phase, all in `themegrill/.github`:

- `.github/workflows/crisp-triage.yml` — the hourly pipeline
- `scripts/crisp-client.mjs` — shared Crisp REST client (auth, fetch, post)
- `scripts/crisp-classify.mjs` — Stage 1: fetch + cheap classify
- `scripts/crisp-fetch-transcript.mjs`, `scripts/build-prompt.mjs`, `scripts/crisp-post-note.mjs` — Stage 2 helpers
- `prompts/crisp-triage-agent.md` — the agent's instructions
- `state/cursor.json` — persisted "last checked" timestamp
- `state/investigated.json` — session_ids that already went through a full Stage 2 investigation at least once, so a conversation that resolves, gets reopened by the customer, and resolves again doesn't get reinvestigated (and re-noted) every cycle
- `config/inbox-to-repo.json` — Crisp inbox → GitHub repo mapping (**you must populate this**)

## 1. Crisp API tokens — one per account, not one total

`user-registration` and `themegrill` are on **separate Crisp accounts** (different logins), not just different inboxes under one account — confirmed directly, not assumed. That means **two independent tokens**, created separately in each account, and credentials cannot be shared between them.

Use a **Website Token**, not a Plugin Token — this matters, they're genuinely different things:
- A **Plugin Token** requires a separate Marketplace developer account, creating a "plugin" there, requesting production-scope approval, and installing it on the website via a private install link. That's for third-party/distributable integrations — overkill for our own internal automation.
- A **Website Token** is generated directly inside the workspace, no Marketplace account, no approval step. This is the right one.

For **each** account: log into that Crisp account → **Settings → Workspace Settings → Advanced configuration** → **API Token** section → **Generate Token**. Copy the pair immediately — shown only once. This also gives you the website ID (visible in that same settings area, or in the URL).

Note: Website Tokens are capped at 10,000 requests/day and only a workspace owner can manage them — both are fine for our hourly-poll volume.

Naming convention — the account key (`USER_REGISTRATION`, `THEMEGRILL`, matching `config/inbox-to-repo.json`) must exactly match the suffix in these names:

| Account | Secrets | Variable (not a secret) |
|---|---|---|
| User Registration | `CRISP_USER_REGISTRATION_IDENTIFIER`, `CRISP_USER_REGISTRATION_KEY` | `CRISP_USER_REGISTRATION_WEBSITE_ID` |
| ThemeGrill | `CRISP_THEMEGRILL_IDENTIFIER`, `CRISP_THEMEGRILL_KEY` | `CRISP_THEMEGRILL_WEBSITE_ID` |

The website ID is a plain **repo variable**, not a secret — it's an identifier, not a credential, and Phase 1 already taught us the cost of treating a non-secret as one: GitHub masks any string matching a secret's value everywhere it appears, including inside unrelated plain text. Repo variables: Settings → Secrets and variables → Actions → **Variables** tab.

Onboarding a third Crisp account later means: create its token, add its three secrets/variable following the same naming convention, add its account key + inbox mappings to `config/inbox-to-repo.json`, and add its three lines to the `classify` job's `env:` block in the workflow (Stage 2 already resolves credentials dynamically by account, no workflow change needed there).

## 2. Model provider — currently OpenAI (swap later freely)

Using OpenAI for now since that key already exists; not a hardcoded commitment — Robert's own team mixes providers and switches per cost/quality, and everything here reads the provider via env vars/config, not hardcoded calls.

- Org secret `OPENAI_API_KEY`.
- Repo variables `CLASSIFY_MODEL` and `INVESTIGATE_MODEL` (both default to `gpt-5-mini` in the workflow if unset). **Verify the exact model id against your own OpenAI account** (platform.openai.com/docs/models) before trusting the default — some names circulating as of writing (e.g. "GPT-5.6 Terra/Luna") come from low-quality pricing-aggregator sites, not confirmed OpenAI documentation.
- `gpt-5-mini` is a reasonable Stage 1 classifier (cheap, tool-less). For Stage 2's actual code investigation, consider a stronger reasoning-tier model once you've confirmed the plumbing works — `gpt-5-mini` is fine for proving the pipeline, not necessarily for investigation quality.
- If/when an Anthropic key arrives: swap `OPENAI_API_KEY` references for `ANTHROPIC_API_KEY`, change the classify script's endpoint to `api.anthropic.com/v1/messages`, and change `--model "openai/..."` to `--model "anthropic/..."` in the workflow. **Anthropic must be a pay-as-you-go API key** — their terms prohibit using a Claude subscription (Free/Pro/Max) OAuth token in third-party tools like OpenCode.

## 3. Upgrade `tg-autopilot`'s PAT scope

Phase 1's PAT has **Contents: Read-only**. Stage 1 needs to commit the advanced `cursor.json` back to `themegrill/.github`, which needs **Contents: Read and write** on that specific repo. Edit the existing fine-grained PAT (or issue a new one) to add that scope.

## 4. Populate `config/inbox-to-repo.json`

`USER_REGISTRATION` maps directly to one repo. `THEMEGRILL` is different: one Crisp account serves 25+ themes/plugins with no structured signal (segments are generic tags like "free"/"night", not per-product) for which one a conversation is about — so Stage 1's classifier reads the transcript itself and names a product from the known list in `config/inbox-to-repo.json`, plus whether it's the free or pro edition. An unmatched/unidentifiable product is **skipped and logged in the run summary, not guessed at** — check there periodically and add real products the classifier is missing.

## 4b. A second bot token, because two orgs

`themegrill` repos (colormag, zakra, etc.) are a different GitHub org from `wpeverest`, and a fine-grained PAT is scoped to exactly **one** resource owner. `tg-autopilot`'s existing PAT (scoped to `wpeverest`) cannot reach them, regardless of `tg-autopilot`'s org membership.

- Generate a **second** fine-grained PAT for `tg-autopilot`, **resource owner: `themegrill`**, repository access "All repositories" if available (28+ products and growing), permissions: Contents Read, Issues Read+write, Pull requests Read+write, Metadata Read.
- Store it as org secret **`BOT_TOKEN_THEMEGRILL`** — in `wpeverest`, same as every other secret, because that's where the workflow *runs*, regardless of which org the token itself grants access into.
- `themegrill`'s org default repo permission happens to be **write** for all members, so once `tg-autopilot` is a member there, it already has write access to every repo — no per-repo collaborator setup was needed, just the org invite and this token.
- The workflow picks whichever token matches a conversation's target repo's org: `startsWith(matrix.repo, 'themegrill/') && secrets.BOT_TOKEN_THEMEGRILL || secrets.BOT_TOKEN`. Onboarding a third org later means the same pattern: a new PAT, a new secret, one more branch in that expression (or, once there are more than two, worth switching to a lookup table instead).

## 4c. What actually triggers a full investigation

**Policy: a resolved conversation is trusted as fully handled by support.** Resolving it — first time or the tenth time — never triggers investigation on its own; the resolved-conversation loop in `crisp-classify.mjs` only records "session X seen resolved at time T" into `state/resolved-seen.json`, nothing more. Three things can still trigger a full investigation:

- **Manual**: a support agent adds a private note containing `!tg-autopilot investigate`. Skips the cheap classifier entirely — a human already made the call — and goes straight to full investigation, on the *full* transcript regardless of any of the below. Works any number of times; each *new* note re-triggers it (tracked by counting matching notes per conversation, not by trying to identify "which" note, since two notes can have identical text). Detection has two layers: the cheap path only fetches full messages for conversations already touched since `cursor.last_checked` (adding a note is itself an update); separately, `searchConversationsForManualTrigger()` searches Crisp directly for the trigger phrase and appends anything found there too, regardless of `fetchActiveConversations`' page cap. The second layer exists because the first one alone isn't reliable on a high-volume account — confirmed for real on `THEMEGRILL`: a manually-noted conversation didn't rank in the top 200 most-recently-updated active conversations because 200+ *other* conversations were touched in the same window, so it never got its message history fetched at all. A manual trigger is an explicit human action and shouldn't ever silently fail to reach the pipeline just because the account is busy.
- **Reopen after resolve**: a conversation `state/resolved-seen.json` already has a record for shows up in the *active* list again (the customer replied after it was marked resolved). Investigated using only the messages timestamped after that recorded resolve time — whatever was there before is assumed already covered by support's original resolve. If it gets resolved again before a `crisp-triage` run ever catches it in this in-between "active again" state, it's never investigated for that reopen at all — the resolved-conversation loop just records the newer resolve time on its next pass, and there's nothing left to catch. This is intentional, not a bug: by the same policy, a second resolve is trusted as handled too.
- **Automatic, stale-and-never-resolved**: a conversation open longer than **12 hours** (measured from `active.last`, not `created_at`) that has *never* been resolved at all gets checked by the same cheap classifier. If it agrees this looks like a real bug/feature, it's escalated the same way. This fires **at most once per conversation** automatically, and never for a conversation older than **30 days** (`AUTO_ESCALATE_MAX_HOURS` in `crisp-classify.mjs`) -- a backlog that's sat untouched that long is treated as intentionally left open, not a scan miss. This path is unrelated to the reopen path above — it exists for tickets that were *never* marked resolved, which the "trust the resolve" policy says nothing about.

  **Onboarding a new account: run `Seed escalated state for a new Crisp account` (`.github/workflows/seed-escalated.yml`, `workflow_dispatch`, input = the account key) once, before that account's first scheduled `crisp-triage` run.** `escalated.json` has no history for a brand-new account, so every one of its currently-active conversations already past 12 hours old looks auto-escalation-eligible on day one -- confirmed for real onboarding User Registration: ~83% of its ~400-conversation active backlog auto-escalated within the first few minutes of a single run. The seed workflow marks the current backlog as already-escalated so none of it fires; only conversations that go stale *after* seeding will auto-escalate from then on. It doesn't touch the manual-note path -- `!tg-autopilot investigate` still works on any of those backlog conversations if someone wants one looked at anyway.

All three paths write to `state/escalated.json` and/or `state/resolved-seen.json` (both committed) so none of them repeats itself needlessly.

**Separately**, `state/investigated.json` (also committed) tracks every session_id that has ever completed a full Stage 2 investigation, from *any* path. The reopen and stale-auto-escalation branches both skip a session already in this set for the *same* unresolved content — a conversation reopening with a genuinely new, unrelated problem after already being investigated once still gets picked up, since the reopen path is driven by `resolved-seen.json`'s timestamp, not this set. The manual-note path deliberately does **not** check this set — a human explicitly asking to (re-)investigate should always go through.

**Rollout note**: `state/resolved-seen.json` starts empty when this policy first ships. A conversation that was resolved *before* that point and reopens shortly after has no prior "seen resolved" record yet, so that first reopen looks like a first-time resolve and gets skipped rather than recognized as a reopen — it self-corrects from its next resolve onward. Accepted as a one-time gap rather than backfilling the whole history.

## 4d. Investigate-job concurrency and OpenAI rate limits

Every "Investigate" job (one per matrix entry) shares one org-wide OpenAI TPM budget. Confirmed for real: a run with ~10 concurrent investigate jobs hit `429 rate_limit_exceeded` on `gpt-5-mini` repeatedly, and several jobs never recovered -- OpenCode's CLI exited `0` anyway, with no issue filed and no note posted, making a silently-dropped conversation look identical to a successful one in the Actions UI.

Two mitigations are in place in `crisp-triage.yml`:
- `max-parallel: 4` on the investigate matrix -- doesn't eliminate rate limiting, just makes it less likely by not firing every job at once.
- After `opencode run` finishes, the workflow checks whether the agent actually called `crisp-post-note.mjs` (its mandatory last step per `prompts/crisp-triage-agent.md`, rule 5). If that call never shows up in the output, the step fails explicitly instead of reporting success.

**If an investigate job fails this way**, re-run just that job from the Actions run page (or "Re-run failed jobs" for the whole run) -- it retries the same `session_id`/`repo`/`kind`, no state to reset first. If this becomes frequent, the next lever is raising `INVESTIGATE_MODEL`'s tier (a higher tier typically also carries a higher TPM ceiling) or lowering `max-parallel` further.

## 5. Sanity-check cost before enabling the schedule

ThemeIsle's own numbers: $0.0003 per conversation when Stage 1 (or a quick Stage 2 look) concludes "no bug," up to ~$2 for a deep investigation that finds and files a real bug. Before turning on the hourly cron, estimate your actual resolved-conversation volume and multiply by a rough blended cost to sanity-check the monthly bill. Start with `workflow_dispatch` manual runs, not the schedule, until you trust the numbers.

## Verification

1. **Dry run one conversation**: manually resolve a test conversation in Crisp with an obvious, reproducible bug description, then run the workflow via `workflow_dispatch`. Confirm: the right repo gets checked out, an issue is filed with the full structured body, and `cursor.json` advances.
2. **Dedupe**: resolve a second conversation describing the *same* bug → confirm a comment on the existing issue, not a duplicate.
3. **Client-side note-back**: resolve a conversation that's clearly a client-side misunderstanding → confirm a note lands in that Crisp conversation and no GitHub issue is filed.
4. **Cursor correctness**: run again with no new conversations → confirm nothing gets re-processed.
