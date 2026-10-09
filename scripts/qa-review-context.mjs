// Gathers and shapes everything the QA review sees. Read-only: this never
// checks out or executes PR code. It only reads the diff through the API and
// the product's committed QA data (.themegrill-qa/) at the BASE branch -- not
// the PR head -- so a PR cannot rewrite the knowledge the review is judged by.

// ---- area mapping (deterministic, no LLM) -------------------------------

export function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = esc.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

// -> { areas: { name: [files] }, unmapped: [files] }. A file can hit several areas.
export function mapAreas(filenames, areaPaths = {}) {
  const compiled = Object.entries(areaPaths).map(([area, globs]) => [area, globs.map(globToRegExp)]);
  const areas = {};
  const unmapped = [];
  for (const f of filenames) {
    let hit = false;
    for (const [area, res] of compiled) {
      if (res.some((r) => r.test(f))) {
        (areas[area] ??= []).push(f);
        hit = true;
      }
    }
    if (!hit) unmapped.push(f);
  }
  return { areas, unmapped };
}

// ---- diff shaping --------------------------------------------------------

const SKIP = [
  /(^|\/)(vendor|node_modules)\//,
  /\.min\.(js|css)$/,
  /\.(map|lock|po|mo|pot|svg|png|jpe?g|gif|webp|woff2?|ttf|eot|zip)$/i,
  /(^|\/)(package-lock\.json|composer\.lock|yarn\.lock|pnpm-lock\.yaml)$/,
  /-rtl\.css$/,
  /(^|\/)languages\//,
];
const CODE = /\.(php|js|jsx|ts|tsx|mjs|scss|css|json|ya?ml|sh)$/i;

export function isSkipped(filename) {
  return SKIP.some((r) => r.test(filename));
}

// Annotate each line of a unified-diff patch with its NEW-side line number so
// the model can cite exact lines, and so citations can be checked mechanically.
//   "L42+ code" added line, "L40  code" context line, "    - code" removed line.
// Returns { text, addedLines:Set<number> }.
export function annotatePatch(patch) {
  const out = [];
  const addedLines = new Set();
  let newLine = 0;
  for (const raw of String(patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      out.push(raw);
    } else if (raw.startsWith("+")) {
      addedLines.add(newLine);
      out.push(`L${newLine}+ ${raw.slice(1)}`);
      newLine++;
    } else if (raw.startsWith("-")) {
      out.push(`    - ${raw.slice(1)}`);
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" -- not a line
    } else {
      out.push(`L${newLine}  ${raw.slice(1)}`);
      newLine++;
    }
  }
  return { text: out.join("\n"), addedLines };
}

// files: [{filename, status, patch?}] from the pulls/files API.
// Returns the text to show the model, the per-file added-line sets used later
// to verify citations, and honest accounting of what was NOT shown.
export function buildDiff(files, maxChars = 60000) {
  const considered = files.filter((f) => !isSkipped(f.filename));
  const skipped = files.filter((f) => isSkipped(f.filename)).map((f) => f.filename);
  // Code first, so a truncated budget is spent on code rather than docs.
  const ordered = [...considered].sort((a, b) => Number(CODE.test(b.filename)) - Number(CODE.test(a.filename)));

  const parts = [];
  const addedByFile = {};
  const shown = [];
  const omitted = [];
  const noPatch = [];
  let used = 0;
  for (const f of ordered) {
    if (!f.patch) {
      noPatch.push(f.filename); // binary, or too large for the API to include
      continue;
    }
    const { text, addedLines } = annotatePatch(f.patch);
    const block = `=== FILE: ${f.filename} (${f.status}) ===\n${text}\n`;
    if (used + block.length > maxChars) {
      omitted.push(f.filename);
      continue;
    }
    used += block.length;
    parts.push(block);
    addedByFile[f.filename] = addedLines;
    shown.push(f.filename);
  }
  return { text: parts.join("\n"), addedByFile, shown, omitted, skipped, noPatch };
}

export const isTestFile = (f) => /^(tests\/|\.themegrill-qa\/testcases\/)/.test(f);

// ---- GitHub reads --------------------------------------------------------

export function makeReader(token, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const getJson = async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { headers });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    getPr: (repo, n) => getJson(`/repos/${repo}/pulls/${n}`),
    async listFiles(repo, n) {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await getJson(`/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    async listCheckRuns(repo, sha) {
      const j = await getJson(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
      return j.check_runs.map((c) => ({ name: c.name, state: c.conclusion ?? c.status }));
    },
    // Optional file: 404 means "this repo doesn't have it", not an error.
    async getTextAtRef(repo, path, ref) {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
        headers: { ...headers, Accept: "application/vnd.github.raw+json" },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub GET contents/${path} failed: ${res.status} ${await res.text()}`);
      return res.text();
    },
  };
}

const parseJsonOrNull = (s) => {
  try {
    return s == null ? null : JSON.parse(s);
  } catch {
    return null;
  }
};

// The product's QA data, from the base branch. Every piece is optional: a repo
// not onboarded to claudegrill just yields an empty context, and the review
// says so rather than pretending.
export async function loadQaData(reader, repo, baseRef) {
  const [suiteRaw, indexRaw, knowledge] = await Promise.all([
    reader.getTextAtRef(repo, ".themegrill-qa/suite.json", baseRef),
    reader.getTextAtRef(repo, ".themegrill-qa/testcase-index.json", baseRef),
    reader.getTextAtRef(repo, ".themegrill-qa/knowledge.md", baseRef),
  ]);
  const suite = parseJsonOrNull(suiteRaw);
  const index = parseJsonOrNull(indexRaw);
  const titles = (index?.areas ?? []).flatMap((a) => (a.titles ?? []).map((t) => ({ title: t, file: a.file })));
  return {
    areaPaths: suite?.area_paths ?? {},
    titles,
    knowledge: knowledge ?? "",
    present: Boolean(suite || index || knowledge),
  };
}
