#!/usr/bin/env node
// Prints the full topic (first post + replies) as plain text for the agent.
import { fetchText, parseTopicPage, formatTranscript, decodeEntities, TOPIC_URL_RE } from "./wporg-forum.mjs";

const [url] = process.argv.slice(2);
if (!url || !TOPIC_URL_RE.test(url)) {
  console.error("Usage: wporg-fetch-transcript.mjs <https://wordpress.org/support/topic/slug/>");
  process.exit(1);
}
const html = await fetchText(url);
const title = html.match(/<h1 class="page-title">([\s\S]*?)<\/h1>/)?.[1] ?? "";
const posts = parseTopicPage(html);
if (!posts.length) {
  console.error(`::error::Could not parse any posts from ${url} (forum markup changed?)`);
  process.exit(1);
}
process.stdout.write(formatTranscript(decodeEntities(title.replace(/<[^>]+>/g, "")), url, posts));
