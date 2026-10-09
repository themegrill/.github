// Builds a one-click "try this PR" link: WordPress Playground (a WordPress that
// runs in the browser) with the PR's already-built zip installed and activated.
//
// The Blueprint is inlined in the URL fragment as `#` + encodeURIComponent(JSON)
// (documented at developer.wordpress.org/playground/blueprints/tutorial/how-to-load-run/),
// so nothing extra is hosted. The browser DOES fetch the zip itself, so the
// bucket must allow https://playground.wordpress.net via CORS (GET/HEAD).
//
// Inputs come from workflow `inputs:` (set by each repo's own caller, but still
// validated: they end up inside a URL that is posted to a PR).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLAYGROUND = "https://playground.wordpress.net/";
const PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4"];

export function validate({ zipUrl, type, landingPage, php, wp, requires = [] }) {
  let u;
  try {
    u = new URL(zipUrl);
  } catch {
    return "zip url is not a valid URL";
  }
  if (u.protocol !== "https:") return "zip url must be https";
  if (/[\s"'<>\\]/.test(zipUrl)) return "zip url contains unsafe characters";
  if (!/\.zip$/i.test(u.pathname)) return "zip url must end in .zip";
  if (!["plugin", "theme"].includes(type)) return 'type must be "plugin" or "theme"';
  // A path on the Playground site, never an absolute or protocol-relative URL.
  if (!/^\/(?!\/)[A-Za-z0-9._~\-\/?=&%#:+]*$/.test(landingPage ?? "")) return "landing page must be a site path like /wp-admin/";
  if (!PHP_VERSIONS.includes(php)) return `php must be one of ${PHP_VERSIONS.join(", ")}`;
  if (!/^(latest|beta|nightly|\d+\.\d+(\.\d+)?)$/.test(wp ?? "")) return 'wp must be "latest" or a version like 6.8';
  if (!Array.isArray(requires) || requires.some((slug) => !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug))) return "requires must be a list of wordpress.org plugin slugs";
  return null;
}

export function buildBlueprint({ zipUrl, type, landingPage, php, wp, requires = [] }) {
  const install =
    type === "theme"
      ? { step: "installTheme", themeData: { resource: "url", url: zipUrl }, options: { activate: true } }
      : { step: "installPlugin", pluginData: { resource: "url", url: zipUrl }, options: { activate: true } };
  return {
    $schema: "https://playground.wordpress.net/blueprint-schema.json",
    landingPage,
    preferredVersions: { php, wp },
    steps: [
      { step: "login", username: "admin", password: "password" },
      // Plugins this build depends on (e.g. an add-on's base plugin), from wordpress.org, installed first.
      ...requires.map((slug) => ({ step: "installPlugin", pluginData: { resource: "wordpress.org/plugins", slug }, options: { activate: true } })),
      install,
    ],
  };
}

export function buildPreviewUrl(input) {
  const bad = validate(input);
  if (bad) throw new Error(bad);
  // storage=temp: a throwaway site, not one saved into the viewer's browser each click.
  return `${PLAYGROUND}?storage=temp#${encodeURIComponent(JSON.stringify(buildBlueprint(input)))}`;
}

const DEFAULTS = { type: "plugin", landingPage: "/wp-admin/plugins.php", php: "8.2", wp: "latest" };

// mode: "false" never; "true" always (caller's inputs); "auto" only for repos
// enrolled in config/preview-link-repos.json. Precedence for each setting:
// caller input > enrolled entry > default. Returns null when no link should be made.
export function resolveSettings({ mode, entry, input }) {
  const m = String(mode || "auto").toLowerCase();
  if (m === "false") return null;
  if (m === "auto" && !entry) return null;
  if (!["auto", "true"].includes(m)) throw new Error('preview-link must be "auto", "true" or "false"');
  const pick = (k) => input[k] || entry?.[k] || DEFAULTS[k];
  return { type: pick("type"), landingPage: pick("landingPage"), php: pick("php"), wp: pick("wp"), requires: entry?.requires ?? [] };
}

function readConfig(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const e = process.env;
  const config = readConfig(e.PREVIEW_CONFIG_PATH);
  const settings = resolveSettings({
    mode: e.PREVIEW_LINK,
    entry: config[e.PREVIEW_REPO],
    input: { type: e.PREVIEW_TYPE, landingPage: e.PREVIEW_LANDING_PAGE, php: e.PREVIEW_PHP, wp: e.PREVIEW_WP },
  });
  if (!settings) {
    console.log(`No preview link: ${e.PREVIEW_REPO || "this repo"} is not enrolled (config/preview-link-repos.json) and preview-link is not "true".`);
    return;
  }
  const url = buildPreviewUrl({ zipUrl: e.PREVIEW_ZIP_URL, ...settings });
  console.log(url);
  if (e.GITHUB_OUTPUT) appendFileSync(e.GITHUB_OUTPUT, `url=${url}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`::warning::Preview link not generated: ${err.message}`);
    process.exit(1);
  }
}
