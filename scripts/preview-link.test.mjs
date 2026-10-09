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
