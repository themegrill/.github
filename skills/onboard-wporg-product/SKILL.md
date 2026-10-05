---
name: onboard-wporg-product
description: Add a plugin or theme to the WordPress.org forum triage pipeline (wporg/), or debug why a forum topic was or wasn't picked up.
---

# Onboard a product to wp.org forum triage

Read `wporg/README.md` first.

1. Confirm the forum feed exists: `curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0" https://wordpress.org/support/<plugin|theme>/<slug>/feed/` must be 200. Plugin vs theme matters; the same slug 404s under the wrong one.
2. Add `"<slug>": "<org>/<free-repo>"` under `plugins` or `themes` in `wporg/config/products.json`. wp.org only has the free edition, so use the free repo. Verify the repo exists with `gh repo view`.
3. The next run only **seeds** that product (records existing topics, investigates none). Don't expect an issue from the first run; a topic posted after that is picked up on the following run.
4. To test end to end, use the manual dispatch with `topic_url` + `repo` on a real existing topic. This files a real issue, so pick a repo you can clean up.

## Debugging "topic not investigated"

- Classify log line `... -> not actionable`: classifier said no (conservative by design).
- `skipped (resolved)` / `skipped (older than 14d)` / `over per-run cap`: use the manual dispatch to investigate it anyway.
- Not in the log at all: it's in `state/seen.json` already, or the feed didn't list it (feed holds ~30 latest topics).
- Investigation job failed with "never called wporg-done.mjs": agent died mid-run (rate limit); re-run manually.
- Verify state/workflow changes actually took effect with the `verify-github-actions-change` skill, not by trusting a cached `gh api` GET.
