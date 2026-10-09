import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewUrl, buildBlueprint, validate } from "./preview-link.mjs";

const OK = {
  zipUrl: "https://themegrill-pr-artifacts.s3.amazonaws.com/user-registration-fix-1582-x/user-registration-5.2.8.zip",
  type: "plugin",
  landingPage: "/wp-admin/admin.php?page=user-registration",
  php: "8.2",
  wp: "latest",
};
const decode = (url) => JSON.parse(decodeURIComponent(url.split("#")[1]));

test("plugin link: Playground URL with an inline, round-trippable blueprint", () => {
  const url = buildPreviewUrl(OK);
  assert.ok(url.startsWith("https://playground.wordpress.net/?storage=temp#"));
  const bp = decode(url);
  assert.equal(bp.landingPage, OK.landingPage);
  assert.deepEqual(bp.preferredVersions, { php: "8.2", wp: "latest" });
  assert.deepEqual(bp.steps[0], { step: "login", username: "admin", password: "password" });
  assert.deepEqual(bp.steps[1], { step: "installPlugin", pluginData: { resource: "url", url: OK.zipUrl }, options: { activate: true } });
});

test("theme link installs and activates a theme", () => {
  const bp = decode(buildPreviewUrl({ ...OK, type: "theme", landingPage: "/" }));
  assert.equal(bp.steps[1].step, "installTheme");
  assert.deepEqual(bp.steps[1].themeData, { resource: "url", url: OK.zipUrl });
  assert.equal(bp.steps[1].options.activate, true);
});

test("the fragment holds no raw quotes, spaces or angle brackets, and stays a sane length", () => {
  const frag = buildPreviewUrl(OK).split("#")[1];
  assert.ok(!/["'<>\s{}]/.test(frag));
  assert.ok(buildPreviewUrl(OK).length < 1500);
});

test("validation rejects anything that could smuggle a different URL or step", () => {
  const bad = [
    { zipUrl: "http://x.test/a.zip" }, // not https
    { zipUrl: "https://x.test/a.zip\"},{\"step\":\"runPHP" }, // blueprint injection
    { zipUrl: "https://x.test/a.zip evil" },
    { zipUrl: "https://x.test/a.tar.gz" },
    { zipUrl: "not a url" },
    { type: "mu-plugin" },
    { landingPage: "https://evil.test/" },
    { landingPage: "//evil.test/" },
    { landingPage: "wp-admin/" },
    { landingPage: "/wp-admin/\"><script>" },
    { php: "5.6" },
    { php: "8.2; DROP" },
    { wp: "latest\"" },
    { wp: "six" },
  ];
  for (const over of bad) {
    assert.ok(validate({ ...OK, ...over }), JSON.stringify(over));
    assert.throws(() => buildPreviewUrl({ ...OK, ...over }));
  }
});

test("validation accepts the normal range of inputs", () => {
  for (const over of [{ php: "7.4" }, { php: "8.4" }, { wp: "6.8" }, { wp: "6.8.1" }, { wp: "beta" }, { landingPage: "/" }, { landingPage: "/wp-admin/" }]) {
    assert.equal(validate({ ...OK, ...over }), null, JSON.stringify(over));
  }
});

test("buildBlueprint is pure (no mutation of its input)", () => {
  const copy = JSON.stringify(OK);
  buildBlueprint(OK);
  assert.equal(JSON.stringify(OK), copy);
});

import { resolveSettings } from "./preview-link.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resolveSettings: auto only for enrolled repos; caller input > entry > default", () => {
  const none = { type: "", landingPage: "", php: "", wp: "" };
  assert.equal(resolveSettings({ mode: "auto", entry: undefined, input: none }), null);
  assert.equal(resolveSettings({ mode: undefined, entry: undefined, input: none }), null); // default is auto
  assert.equal(resolveSettings({ mode: "false", entry: { type: "theme" }, input: none }), null);
  assert.deepEqual(resolveSettings({ mode: "auto", entry: {}, input: none }), { type: "plugin", landingPage: "/wp-admin/plugins.php", php: "8.2", wp: "latest", requires: [] });
  const s = resolveSettings({ mode: "auto", entry: { type: "theme", php: "8.1", requires: ["user-registration"] }, input: { ...none, php: "8.3" } });
  assert.deepEqual([s.type, s.php, s.requires], ["theme", "8.3", ["user-registration"]]); // caller beats entry
  assert.ok(resolveSettings({ mode: "true", entry: undefined, input: none })); // force on, no entry needed
  assert.throws(() => resolveSettings({ mode: "yes", entry: {}, input: none }), /auto.*true.*false/);
});

test("requires: base plugins are installed from wordpress.org before the build, and slugs are validated", () => {
  const bp = decode(buildPreviewUrl({ ...OK, requires: ["user-registration"] }));
  assert.deepEqual(bp.steps.map((s) => s.step), ["login", "installPlugin", "installPlugin"]);
  assert.deepEqual(bp.steps[1].pluginData, { resource: "wordpress.org/plugins", slug: "user-registration" });
  assert.equal(bp.steps[2].pluginData.url, OK.zipUrl); // ours last
  for (const bad of [["Bad Slug"], ["a/b"], ["x\"y"], [""], "user-registration"]) {
    assert.ok(validate({ ...OK, requires: bad }), JSON.stringify(bad));
  }
});

// Run the script exactly as the workflow does (env in, stdout / GITHUB_OUTPUT out).
function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "preview-"));
  const config = join(dir, "repos.json");
  writeFileSync(config, JSON.stringify({ "org/enrolled": { type: "plugin" } }));
  const out = join(dir, "gh-output");
  writeFileSync(out, "");
  const r = spawnSync(process.execPath, ["scripts/preview-link.mjs"], {
    env: { PATH: process.env.PATH, PREVIEW_CONFIG_PATH: config, PREVIEW_ZIP_URL: OK.zipUrl, GITHUB_OUTPUT: out, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(out, "utf8") };
}

test("script: enrolled repo gets a link in GITHUB_OUTPUT; others get nothing and still succeed", () => {
  const yes = run({ PREVIEW_REPO: "org/enrolled" });
  assert.equal(yes.status, 0);
  assert.match(yes.output, /^url=https:\/\/playground\.wordpress\.net\//);

  const no = run({ PREVIEW_REPO: "org/other" });
  assert.equal(no.status, 0); // must never fail the build over this
  assert.equal(no.output, "");
  assert.match(no.stdout, /not enrolled/);

  assert.equal(run({ PREVIEW_REPO: "org/enrolled", PREVIEW_LINK: "false" }).output, "");
  assert.match(run({ PREVIEW_REPO: "org/other", PREVIEW_LINK: "true" }).output, /^url=/); // forced on
});

test("script: bad input is a warning + non-zero exit (the workflow step is continue-on-error)", () => {
  const r = run({ PREVIEW_REPO: "org/enrolled", PREVIEW_ZIP_URL: "http://insecure.test/a.zip" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /::warning::Preview link not generated/);
  assert.equal(r.output, "");
  assert.equal(run({ PREVIEW_REPO: "org/enrolled", PREVIEW_LINK: "bogus" }).status, 1);
});

test("the real enrolment file parses and every entry passes validation", () => {
  const cfg = JSON.parse(readFileSync(new URL("../config/preview-link-repos.json", import.meta.url), "utf8"));
  for (const [repo, entry] of Object.entries(cfg)) {
    assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
    const s = resolveSettings({ mode: "auto", entry, input: {} });
    assert.equal(validate({ zipUrl: OK.zipUrl, ...s }), null, repo);
  }
});
