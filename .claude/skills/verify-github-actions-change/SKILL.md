---
name: verify-github-actions-change
description: How to actually confirm a GitHub Actions / repo-settings mutation took effect, instead of trusting a re-check that might be serving stale/cached data.
---

# Verify a GitHub Actions mutation actually took effect

## The trap

The `gh` CLI (both `gh api` and higher-level commands built on it) can serve a **cached response** for a `GET` shortly after a `PUT`/`DELETE` you just made. Confirmed for real while debugging a Copilot-reviewer issue: removing then re-adding a PR reviewer showed the *old* state on the very next `gh api .../requested_reviewers` call, making a real fix look like it hadn't worked at all.

This also compounds with **GitHub Actions' own indexing lag**: a newly merged workflow file can be confirmed present via the Contents API immediately, yet `workflow_dispatch` still 404s on it for over a minute before it's actually dispatchable.

## The fix

- When a mutation's result looks stale or contradicts what should have just changed, re-check with a plain `curl` instead of `gh api` — it bypasses the CLI's caching.
- If `curl` also shows the old state, wait (tens of seconds, not milliseconds) and retry before concluding the fix didn't work.
- For a workflow file that just landed on the default branch: if `workflow_dispatch` won't dispatch it yet, treat that as expected indexing lag first, not evidence the file is malformed — wait and retry before debugging the YAML itself.

## When this matters most

Any time you've just made a change and the *very next* verification check comes back looking wrong — pause before concluding the fix failed. The two most common causes in this system have both been caching/indexing lag, not a real regression, often enough that it's worth ruling out first.

## A different trap: a stale local branch name silently absorbing your push

`git push origin <branch-name>` with no local branch checked out under that exact name resolves to *whatever ref git finds matching that name* — including a leftover local branch from an **earlier, already-merged, remote-deleted** PR that used the same name. Confirmed for real: a branch name was reused for a second, larger fix; the push silently succeeded, but against the old stale local ref, not the new work; the resulting PR's merge commit had **zero file changes** — it was byte-identical to the already-merged first PR, title and body included, because that's genuinely all it contained.

**The fix, every time, no exceptions:**
- After pushing a branch you intend to open a PR from, verify its *actual remote content* directly — `gh api repos/OWNER/REPO/contents/PATH?ref=BRANCH` for the specific file(s) you changed, checking for the actual new content, not just that the API call succeeds.
- After a PR merges, check the merge commit's own `files` list (`gh api repos/OWNER/REPO/commits/SHA --jq '.files'`) is non-empty and matches what you expected — an empty or unexpected `files` list on a merge you just made is the tell that something upstream of the PR was already wrong.
- Delete a branch locally (not just check out something else) once its PR is merged, so its name can never be silently reused by a later `git push origin <same-name>` from a fresh local branch that happens to share it.
