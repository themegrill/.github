# Architecture

A map of how tg-autopilot works, for someone new to the repo. Diagrams are Mermaid, so GitHub renders them inline. For the *why* behind each rule, follow the links to [PHASE2-SETUP.md](PHASE2-SETUP.md) and the dated entries in [CHANGELOG.md](CHANGELOG.md).

There is no server. Everything is a GitHub Actions workflow running under one machine user, `tg-autopilot`.

## 1. The three lanes

```mermaid
flowchart TB
  subgraph A["PR build zip + Copilot review"]
    A1[PR ready for review<br/>in an onboarded repo] --> A2[Per-repo caller<br/>pr-build-zip.caller.yml]
    A2 --> A3[Reusable workflow<br/>pr-build-zip.yml]
    A3 --> A4[Build plugin ZIP<br/>upload to S3]
    A4 --> A5[One PR comment<br/>with download link]
    A6[PR opened, or trigger-phrase comment] --> A7[copilot-review-on-comment.yml<br/>requests Copilot as reviewer]
  end

  subgraph B["Crisp triage"]
    B1[Schedule every 3h<br/>or instant webhook] --> B2[Stage 1: scan Crisp<br/>crisp-classify.mjs]
    B2 --> B3[Stage 2: investigate<br/>agent reads the repo]
    B3 --> B4[GitHub issue<br/>or comment on a match]
    B3 --> B5[One note back in Crisp]
  end

  subgraph C["Repo onboarding (manual)"]
    C1[Maintainer runs<br/>workflow_dispatch] --> C2[Repo list<br/>config/copilot-review-repos.json]
    C2 --> C3[propagate-*.mjs<br/>idempotent, per repo]
    C3 --> C4[Opens a PR adding<br/>the caller workflow]
    C3 --> C5[Sets repo-level secrets]
  end

  C4 -. installs .-> A2
  C4 -. installs .-> A7
```

Shared by all three: the machine user, two org-scoped tokens (`BOT_TOKEN` for `wpeverest`, `BOT_TOKEN_THEMEGRILL` for `themegrill`), and committed state in `state/`. See the README's "How the cross-org access works".

## 2. Crisp triage: which conversations get investigated

Policy in one line: **a resolved conversation is trusted as handled and never investigated on its own.** Only three things escalate one. Full reasoning: [PHASE2-SETUP.md § 4c](PHASE2-SETUP.md#4c-what-actually-triggers-a-full-investigation).

```mermaid
flowchart TB
  S[Stage 1: for each Crisp account<br/>fetch resolved since cursor + active list] --> R[Resolved]
  S --> M[Manual note<br/>'!tg-autopilot investigate']
  S --> O[Reopened<br/>active after a resolve]
  S --> T[Stale 12h to 30d<br/>never resolved]

  R --> R1[Record in resolved-seen.json<br/>no investigation]
  M -->|skips classifier<br/>full transcript| E
  O -->|new messages only,<br/>plus opening messages| C
  T -->|only if new messages<br/>since last check| C
  C{Cheap classifier<br/>actionable bug or feature?}
  C -->|yes| E[Escalate: write matrix.json<br/>session, repo, kind, account]
  C -->|no| X[Skipped, logged]

  E --> I[Stage 2: investigate job<br/>one per session, max 4 in parallel]
  I --> I1[Search open issues<br/>bug and feature judged separately]
  I1 --> I2[File new issue with QA label<br/>or comment on the match]
  I2 --> I3[Post one Crisp note<br/>job fails if the agent skips this]

  S --> ST[Commit advanced state<br/>cursor, escalated, resolved-seen, investigated]
```

Also part of the scheduled run: `crisp-dedupe-active.mjs` checks active conversations against open issues. It never files a new issue, only comments on an existing match and notes the Crisp conversation.

`crisp-investigate-now.yml` is the instant path. A Crisp webhook (via n8n) fires `repository_dispatch`, and `crisp-resolve-dispatch.mjs` resolves that one session to a repo, then runs the same Stage 2.

## 3. Where each file fits

| File | Role |
|---|---|
| `scripts/crisp-classify.mjs` | Stage 1 orchestrator: the four paths above, writes `matrix.json` and state |
| `scripts/crisp-classifier.mjs` | Cheap AI call: actionable? bug or feature? which product/repo? |
| `scripts/crisp-client.mjs` | Crisp API wrapper (retries on 401/429), manual-note counting |
| `scripts/crisp-dedupe-active.mjs` | Match active conversations to open issues, notify both sides |
| `scripts/crisp-resolve-dispatch.mjs` | Instant single-session path |
| `scripts/crisp-fetch-transcript.mjs`, `build-prompt.mjs` | Stage 2 setup: transcript into the agent prompt |
| `scripts/crisp-post-note.mjs` | The agent's mandatory last step: note back in Crisp |
| `scripts/summarize-investigation.mjs` | Turns the agent's raw output into a readable run summary |
| `scripts/seed-escalated.mjs` | One-time seed when onboarding a new Crisp account |
| `scripts/events.mjs`, `events-parse.mjs`, `emit-investigation-event.mjs`, `pricing.mjs` | Best-effort event log to a private data repo (for the dashboard); parse outcome from the Crisp note, estimate cost |
| `scripts/github-client.mjs`, `openai-client.mjs` | Thin API helpers |
| `scripts/propagate-*.mjs` | Roll workflows and secrets out to every repo |
| `prompts/crisp-triage-agent.md` | The Stage 2 agent's instructions |
| `config/inbox-to-repo.json` | Crisp account/product to GitHub repo routing |
| `state/*.json` | The pipeline's only memory; committed after each run |
| `.github/workflows/` | Entry points: `crisp-triage.yml`, `crisp-investigate-job.yml`, `crisp-investigate-now.yml`, `pr-build-zip*.yml`, `copilot-review-*.yml`, `propagate-*.yml`, `seed-escalated.yml` |

## 4. Before you change something

- Check [`skills/`](skills/) first: playbooks for onboarding, debugging, and verifying changes.
- Read the comment attached to a line before editing it; the gotchas live there.
- "Has anything new happened?" checks must use real message timestamps, never conversation-level `active.last` / `updated_at`.
