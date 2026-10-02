#!/usr/bin/env node
// Builds the triage dashboard: reads the event files that events.mjs wrote to
// the private data repo, merges them into one row per conversation per scan,
// and fills scripts/dashboard-template.html with the result. Output is one
// self-contained HTML file.
//
// Usage: build-dashboard.mjs <events-dir> <out.html> [--days N]
//   <events-dir>  a local checkout of the data repo (its `events/` folder is read)
//
// Rows:
//   - a scan entry the classifier rejected        -> outcome "skipped"
//   - an escalated entry with an investigation     -> that investigation's outcome
//   - an escalated entry with NO investigation     -> "unrecorded" (the job never
//     reported back: run cancelled, or the job died before its event step)
//   - an investigation with no scan (orphan)       -> still shown
// Scan and investigation are paired on (run_id, session_id): Stage 2 runs inside
// the same workflow run as the scan that escalated it.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".json")) yield full;
  }
}

export async function loadEvents(eventsDir) {
  const events = [];
  for await (const file of walk(eventsDir)) {
    try {
      const e = JSON.parse(await readFile(file, "utf8"));
      if (e && e.type) events.push(e);
    } catch {
      console.warn(`skipping unreadable event file: ${file}`);
    }
  }
  return events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

const num = (v) => (typeof v === "number" ? v : 0);

export function buildRows(events) {
  const scans = events.filter((e) => e.type === "scan");
  const invByKey = new Map(); // later events win (a re-run attempt replaces the earlier one)
  for (const e of events.filter((x) => x.type === "investigation")) {
    invByKey.set(`${e.run_id}:${e.session_id}`, e);
  }
  const used = new Set();
  const rows = [];

  for (const scan of scans) {
    const seen = new Set();
    for (const c of scan.conversations ?? []) {
      if (seen.has(c.session_id)) continue; // a session can be claimed twice in one scan
      seen.add(c.session_id);
      const key = `${scan.run_id}:${c.session_id}`;
      const inv = c.escalated ? invByKey.get(key) : null;
      if (inv) used.add(key);
      const outcome = !c.escalated ? "skipped" : inv ? inv.outcome : "unrecorded";
      rows.push({
        id: key,
        ts: inv?.started_at ?? scan.ended_at ?? scan.ts,
        scan_ts: scan.ended_at ?? scan.ts,
        session_id: c.session_id,
        account: c.account ?? inv?.account ?? null,
        repo: c.repo ?? inv?.repo ?? null,
        kind: c.kind ?? inv?.kind ?? null,
        path: c.path ?? null,
        trigger: scan.trigger ?? null,
        outcome,
        reason: c.escalated ? inv?.reason ?? null : c.reason ?? null,
        items: inv?.items ?? [],
        run_url: scan.run_url ?? null,
        duration_s: inv?.duration_s ?? null,
        classifier: c.classifier ?? null,
        agent: inv?.agent ?? null,
        cost: num(c.classifier?.cost_usd) + num(inv?.agent?.cost_usd),
      });
    }
  }

  for (const inv of invByKey.values()) {
    const key = `${inv.run_id}:${inv.session_id}`;
    if (used.has(key)) continue;
    rows.push({
      id: key, ts: inv.started_at ?? inv.ts, scan_ts: null, session_id: inv.session_id, account: inv.account ?? null,
      repo: inv.repo ?? null, kind: inv.kind ?? null, path: null, trigger: null, outcome: inv.outcome, reason: inv.reason ?? null,
      items: inv.items ?? [], run_url: inv.run_url ?? null, duration_s: inv.duration_s ?? null,
      classifier: null, agent: inv.agent ?? null, cost: num(inv.agent?.cost_usd),
    });
  }

  return rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

export function renderPage(template, data) {
  // `<` escaped so a value can never close the surrounding <script> tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return template.replace("/*__DATA__*/null", () => json);
}

async function main() {
  const args = process.argv.slice(2);
  const [eventsDir, outPath] = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
  const daysIdx = args.indexOf("--days");
  const days = daysIdx > -1 ? Number(args[daysIdx + 1]) : 30;
  if (!eventsDir || !outPath) {
    console.error("Usage: build-dashboard.mjs <events-dir> <out.html> [--days N]");
    process.exit(1);
  }
  const events = await loadEvents(eventsDir);
  const cutoff = Date.now() - days * 86400000;
  const rows = buildRows(events).filter((r) => !r.ts || new Date(r.ts).getTime() >= cutoff);
  const template = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard-template.html"), "utf8");
  await writeFile(outPath, renderPage(template, { generated_at: new Date().toISOString(), days, rows }));
  console.log(`Read ${events.length} events -> ${rows.length} rows (last ${days} days) -> ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
