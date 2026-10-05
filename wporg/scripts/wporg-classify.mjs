#!/usr/bin/env node
// Stage 1 for the WordPress.org forum pipeline: read each product's forum
// feed, classify topics we haven't seen, write matrix.json for Stage 2.
//
// Modes:
//   default                  scan every feed in config/products.json
//   TARGET_TOPIC_URL (+ TARGET_REPO, TARGET_KIND)
//                            skip feeds and classifier, investigate one topic
//
// State (wporg/state/seen.json) is committed by the workflow BEFORE Stage 2
// runs, same as Crisp's escalated.json: a failed investigation is retried by
// a manual dispatch with TARGET_TOPIC_URL, not by the next scan.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFeed, parseResolvedUrls, fetchText, TOPIC_URL_RE, topicSlug } from "./wporg-forum.mjs";
import { classifyTopic } from "./wporg-classifier.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(root, "state/seen.json");
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 14);
const PRUNE_DAYS = 90;
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 10);

const config = JSON.parse(await readFile(join(root, "config/products.json"), "utf8"));
const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
const now = Date.now();
const matrix = [];

// fallback_repo is "" when none; the workflow probes write access and only
// uses it if the token cannot write issues to `repo`.
const entry = (topic_url, repo, kind) => ({
  topic_url,
  slug: topicSlug(topic_url),
  repo,
  kind,
  fallback_repo: config.fallback_repos?.[repo] ?? "",
});

async function main() {
  const target = process.env.TARGET_TOPIC_URL;
  if (target) return manual(target);

  let failed = 0;
  let total = 0;
  for (const type of ["plugin", "theme"]) {
    for (const [slug, repo] of Object.entries(config[`${type}s`])) {
      total++;
      try {
        await scan(type, slug, repo);
      } catch (e) {
        failed++;
        console.error(`::warning::${type}/${slug}: ${e.message}`);
      }
    }
  }
  // One flaky feed must not fail the run, but everything failing is a real outage.
  if (failed === total) throw new Error("Every feed failed");
}

async function scan(type, slug, repo) {
  const items = parseFeed(await fetchText(`https://wordpress.org/support/${type}/${slug}/feed/`));
  const key = `${type}/${slug}`;

  // First time we see a product: record what is already there and investigate
  // none of it. Otherwise onboarding a product floods Stage 2 with its backlog.
  if (!state.seeded[key]) {
    for (const it of items) state.topics[it.url] = new Date(now).toISOString();
    state.seeded[key] = new Date(now).toISOString();
    console.log(`${key}: seeded ${items.length} existing topics, none investigated`);
    return;
  }

  // Resolved topics are skipped (marked seen, never investigated); re-open one
  // with the manual dispatch. A failed list-page fetch means "unknown", which
  // is treated as not resolved -- better one extra investigation than a
  // silent skip.
  let resolved = new Set();
  try {
    resolved = parseResolvedUrls(await fetchText(`https://wordpress.org/support/${type}/${slug}/`));
  } catch (e) {
    console.warn(`::warning::${key}: could not read the resolved flags (${e.message}); treating all as unresolved`);
  }

  for (const it of items) {
    if (state.topics[it.url]) continue;
    // Matrix values end up in workflow `run:` lines -- only accept the exact shape.
    if (!TOPIC_URL_RE.test(it.url)) {
      console.warn(`${key}: ignoring item with unexpected URL`);
      continue;
    }
    state.topics[it.url] = new Date(now).toISOString(); // mark first: never re-classify
    const ageDays = it.published ? (now - Date.parse(it.published)) / 864e5 : 0;
    if (ageDays > MAX_AGE_DAYS) {
      console.log(`${key}: ${it.url} -> skipped (older than ${MAX_AGE_DAYS}d)`);
      continue;
    }
    if (resolved.has(it.url)) {
      console.log(`${key}: ${it.url} -> skipped (resolved)`);
      continue;
    }
    if (matrix.length >= MAX_NEW_PER_RUN) {
      console.log(`${key}: ${it.url} -> over per-run cap, left for a manual dispatch`);
      continue;
    }
    const { data } = await classifyTopic(it.title, it.body);
    if (data.actionable && (data.kind === "bug" || data.kind === "feature")) {
      console.log(`${key}: ${it.url} -> escalated to ${repo} (${data.kind})`);
      matrix.push({ topic_url: it.url, slug: topicSlug(it.url), repo, kind: data.kind });
    } else {
      console.log(`${key}: ${it.url} -> not actionable`);
    }
  }
}

// Inputs come from workflow_dispatch free text: validate against the config,
// never trust them as shell-safe.
function manual(url) {
  const repo = process.env.TARGET_REPO;
  const kind = process.env.TARGET_KIND || "bug";
  const known = new Set([...Object.values(config.plugins), ...Object.values(config.themes)]);
  if (!TOPIC_URL_RE.test(url)) throw new Error("TARGET_TOPIC_URL is not a wordpress.org/support/topic URL");
  if (!known.has(repo)) throw new Error(`TARGET_REPO must be one of the repos in config/products.json`);
  if (!["bug", "feature"].includes(kind)) throw new Error("TARGET_KIND must be bug or feature");
  const canonical = url.replace(/\/*$/, "/");
  state.topics[canonical] = new Date(now).toISOString();
  matrix.push(entry(canonical, repo, kind));
}

try {
  await main();
} finally {
  for (const [u, t] of Object.entries(state.topics)) {
    if (now - Date.parse(t) > PRUNE_DAYS * 864e5) delete state.topics[u];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  await writeFile("matrix.json", JSON.stringify(matrix));
  console.log(`matrix: ${matrix.length} topic(s)`);
}
