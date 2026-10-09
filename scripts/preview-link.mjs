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
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLAYGROUND = "https://playground.wordpress.net/";
const PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4"];

export function validate({ zipUrl, type, landingPage, php, wp }) {
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
  return null;
}

export function buildBlueprint({ zipUrl, type, landingPage, php, wp }) {
  const install =
    type === "theme"
      ? { step: "installTheme", themeData: { resource: "url", url: zipUrl }, options: { activate: true } }
      : { step: "installPlugin", pluginData: { resource: "url", url: zipUrl }, options: { activate: true } };
  return {
    $schema: "https://playground.wordpress.net/blueprint-schema.json",
    landingPage,
    preferredVersions: { php, wp },
    steps: [{ step: "login", username: "admin", password: "password" }, install],
  };
}

export function buildPreviewUrl(input) {
  const bad = validate(input);
  if (bad) throw new Error(bad);
  // storage=temp: a throwaway site, not one saved into the viewer's browser each click.
  return `${PLAYGROUND}?storage=temp#${encodeURIComponent(JSON.stringify(buildBlueprint(input)))}`;
}

function main() {
  const e = process.env;
  const url = buildPreviewUrl({
    zipUrl: e.PREVIEW_ZIP_URL,
    type: e.PREVIEW_TYPE || "plugin",
    landingPage: e.PREVIEW_LANDING_PAGE || "/wp-admin/plugins.php",
    php: e.PREVIEW_PHP || "8.2",
    wp: e.PREVIEW_WP || "latest",
  });
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
