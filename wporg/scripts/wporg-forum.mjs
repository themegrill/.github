// wp.org support forum helpers: parse a forum RSS feed and a topic page.
// No auth needed; both are public. Parsing is regex-based on purpose (no
// dependencies in this repo) and defensive: a markup change must degrade to
// "less text", never throw.

const UA = "tg-autopilot-wporg-triage (+https://github.com/themegrill/.github)";

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|pre|blockquote|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      // Keep link targets; "see this screenshot" is useless without the URL.
      .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) =>
        text.trim() === href ? href : `${text} (${href})`
      )
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseFeed(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
    const url = pick("guid") ?? pick("link");
    if (!url) continue;
    const desc = pick("description")?.replace(/^<!\[CDATA\[|\]\]>$/g, "") ?? "";
    const pub = pick("pubDate");
    const published = pub ? new Date(pub) : null;
    items.push({
      url,
      title: decodeEntities(pick("title") ?? ""),
      published: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
      author: decodeEntities(pick("dc:creator") ?? ""),
      body: htmlToText(desc.replace(/^\s*<p>\s*Replies:\s*\d+\s*<\/p>/i, "")),
    });
  }
  return items;
}

// The feed has no resolved flag; the forum LIST page does: a resolved topic's
// link contains <span class="resolved" aria-label="Resolved">. Returns the set
// of resolved topic URLs on that page. Unknown/unlisted topics are simply
// absent from the set, i.e. treated as NOT resolved (investigate, don't skip).
export function parseResolvedUrls(html) {
  const resolved = new Set();
  for (const m of html.matchAll(/<a class="bbp-topic-permalink" href="([^"]+)">([\s\S]*?)<\/a>/g)) {
    if (/class="resolved"/.test(m[2])) resolved.add(m[1]);
  }
  return resolved;
}

// Returns [{ author, staff, text }]; first entry is the topic itself.
export function parseTopicPage(html) {
  const posts = [];
  const lead = html.match(
    /class="bbp-author-name">([^<]*)<[\s\S]*?<div class="bbp-topic-content">([\s\S]*?)<!-- \.bbp-topic-content -->/
  );
  if (lead) posts.push({ author: decodeEntities(lead[1]), staff: false, text: htmlToText(lead[2]) });

  const re = /<div id="post-\d+" class="([^"]*\breply\b[^"]*)">([\s\S]*?)<!-- \.bbp-reply-content -->/g;
  for (const m of html.matchAll(re)) {
    const author = m[2].match(/class="bbp-author-name">([^<]*)</)?.[1] ?? "";
    const content = m[2].match(/<div class="bbp-reply-content">([\s\S]*)$/)?.[1] ?? "";
    posts.push({
      author: decodeEntities(author),
      staff: /by-plugin-support-rep|by-theme-support-rep|author-badge-(plugin|theme)/.test(m[0]),
      text: htmlToText(content),
    });
  }
  return posts;
}

export function formatTranscript(title, url, posts) {
  const out = [`Topic: ${title}`, `URL: ${url}`, ""];
  posts.forEach((p, i) => {
    const who = i === 0 ? "Original poster" : p.staff ? "Plugin/Theme Support (our team)" : "Forum user";
    out.push(`--- ${who} (${p.author || "unknown"}) ---`, p.text, "");
  });
  return out.join("\n");
}

export async function fetchText(url, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.ok) return await res.text();
      last = new Error(`${url} -> HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
  throw last;
}

export const TOPIC_URL_RE = /^https:\/\/wordpress\.org\/support\/topic\/[a-z0-9%_-]+\/?$/i;
export const topicSlug = (url) => url.replace(/\/+$/, "").split("/").pop();
