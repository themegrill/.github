import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseResolvedUrls, parseTopicPage, htmlToText, formatTranscript, TOPIC_URL_RE } from "./wporg-forum.mjs";

const FEED = `<rss><channel><title>x</title>
<item><guid>https://wordpress.org/support/topic/a-b/</guid><title>Fatal &#8211; error</title>
<pubDate>Tue, 29 Sep 2026 03:59:55 +0000</pubDate><dc:creator>Sam</dc:creator>
<description><![CDATA[<p>Replies: 1</p><p class="x">Hello<br />see <a href="https://e.com/x">this</a></p>]]></description></item>
</channel></rss>`;

test("parseFeed extracts topic fields and drops the Replies line", () => {
  const [it] = parseFeed(FEED);
  assert.equal(it.url, "https://wordpress.org/support/topic/a-b/");
  assert.equal(it.title, "Fatal \u2013 error");
  assert.equal(it.author, "Sam");
  assert.equal(it.published, "2026-09-29T03:59:55.000Z");
  assert.equal(it.body, "Hello\nsee this (https://e.com/x)");
});

test("parseTopicPage reads the lead post and flags staff replies", () => {
  const html = `
<span class="bbp-author-name">Asker</span>
<div class="bbp-topic-content"><p>It breaks</p></div><!-- .bbp-topic-content -->
<div id="post-1" class="loop-item-0 reply type-reply by-plugin-support-rep">
<span class="bbp-author-name">Staff</span>
<div class="bbp-reply-content"><p>Cannot reproduce</p></div><!-- .bbp-reply-content -->`;
  const posts = parseTopicPage(html);
  assert.deepEqual(posts.map((p) => [p.author, p.staff, p.text]), [
    ["Asker", false, "It breaks"],
    ["Staff", true, "Cannot reproduce"],
  ]);
  assert.match(formatTranscript("T", "u", posts), /Plugin\/Theme Support \(our team\) \(Staff\)/);
});

test("markup drift degrades to no posts, never throws", () => {
  assert.deepEqual(parseTopicPage("<html></html>"), []);
  assert.deepEqual(parseFeed("garbage"), []);
});

test("topic URL validation is strict", () => {
  assert.ok(TOPIC_URL_RE.test("https://wordpress.org/support/topic/some-slug/"));
  assert.ok(!TOPIC_URL_RE.test("https://evil.com/support/topic/x/"));
  assert.ok(!TOPIC_URL_RE.test('https://wordpress.org/support/topic/x/"; rm -rf /'));
});

test("htmlToText decodes entities once", () => {
  assert.equal(htmlToText("<p>a &amp;lt; b</p>"), "a &lt; b");
});

test("parseResolvedUrls finds only topics carrying the resolved marker", () => {
  const html = `
<a class="bbp-topic-permalink" href="https://wordpress.org/support/topic/open-one/">Open one</a>
<a class="bbp-topic-permalink" href="https://wordpress.org/support/topic/done-one/"><span class="resolved" aria-label="Resolved" title="Topic is resolved."></span>Done one</a>`;
  assert.deepEqual([...parseResolvedUrls(html)], ["https://wordpress.org/support/topic/done-one/"]);
  assert.equal(parseResolvedUrls("<html></html>").size, 0);
});
