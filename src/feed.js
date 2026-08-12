/**
 * Podcast feed parsing (RSS 2.0, which is what podcasts are in practice).
 *
 * Pure string functions with no dependency on the Workers runtime, so they
 * stay testable with plain `node test.mjs`, same deal as util.js.
 *
 * Regex-based on purpose: a Worker has no DOMParser, and a real XML library
 * would be this project's first runtime dependency. Podcast feeds are
 * machine-generated and shallow, which is the one situation where regex
 * parsing holds up. Anything unrecognized degrades to a skipped item, never
 * to a crash.
 */

const stripCdata = (s) => String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

/** One pass, so "&amp;lt;" decodes to "&lt;" and never twice to "<". */
export function decodeEntities(s) {
  return String(s ?? "").replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gi,
    (m, hex, dec, name) => {
      if (hex) return charOf(parseInt(hex, 16));
      if (dec) return charOf(parseInt(dec, 10));
      const c = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[
        String(name).toLowerCase()
      ];
      return c ?? m;
    }
  );
}
const charOf = (code) => {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
};

/** Plain text out of a fragment that may hold CDATA, entities and markup. */
export function textOf(s) {
  return decodeEntities(stripCdata(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Raw inner content of the first <tag>…</tag>, or "". */
function tagContent(src, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(src);
  return m ? m[1] : "";
}

const firstTag = (src, tags) => {
  for (const t of tags) {
    const v = tagContent(src, t);
    if (v) return v;
  }
  return "";
};

/** Attribute value inside a single already-matched tag string. */
function attrIn(tagStr, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tagStr);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

/** Attribute value of the first <tag …> in src (self-closing or not). */
function tagAttr(src, tag, attr) {
  const m = new RegExp(`<${tag}\\s[^>]*>`, "i").exec(src);
  return m ? attrIn(m[0], attr) : "";
}

/**
 * itunes:duration comes in three shapes in the wild: "3723", "62:03" and
 * "1:02:03". All of them mean seconds by the time this returns.
 */
export function parseDuration(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  if (!/^\d+(:\d+)+$/.test(s)) return 0;
  return s.split(":").reduce((acc, n) => acc * 60 + parseInt(n, 10), 0);
}

/**
 * Storage extension for an enclosure. The Worker serves audio with a
 * Content-Type looked up from this, so only known extensions come out.
 */
export function extFor(type, url) {
  const t = String(type ?? "").toLowerCase();
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
  if (t.includes("ogg") || t.includes("opus")) return "ogg";
  const m = /\.(mp3|m4a|mp4|ogg|oga|opus)(?:$|[?#])/i.exec(String(url ?? ""));
  if (!m) return "mp3";
  const e = m[1].toLowerCase();
  if (e === "m4a" || e === "mp4") return "m4a";
  if (e === "mp3") return "mp3";
  return "ogg";
}

/** The audio enclosure of an item: <enclosure> first, <media:content> after. */
function enclosureOf(item) {
  const found = [];
  for (const tag of ["enclosure", "media:content"]) {
    for (const t of item.match(new RegExp(`<${tag}\\s[^>]*>`, "gi")) ?? []) {
      const url = attrIn(t, "url");
      if (!url) continue;
      found.push({
        url: decodeEntities(url.trim()), // "&amp;" is common inside query strings
        type: attrIn(t, "type").toLowerCase(),
        length: parseInt(attrIn(t, "length") || attrIn(t, "fileSize") || "0", 10) || 0,
      });
    }
  }
  return found.find((e) => e.type.startsWith("audio/")) ?? found[0] ?? null;
}

/**
 * Parses a whole feed. Returns null when the text is not recognizable as an
 * RSS feed at all; otherwise a channel object whose episodes hold only items
 * that actually carry an audio enclosure.
 */
export function parseFeed(xml, maxItems = 200) {
  const src = String(xml ?? "");
  if (!/<(rss|feed|channel)[\s>]/i.test(src)) return null;

  const items = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
  let m;
  while ((m = re.exec(src)) && items.length < maxItems) items.push(m[1]);

  // Channel metadata lives before the first item; slicing it off keeps the
  // channel <title> from matching an episode's.
  const cut = src.search(/<item[\s>]/i);
  const head = cut === -1 ? src : src.slice(0, cut);

  const image =
    tagAttr(head, "itunes:image", "href") || textOf(tagContent(tagContent(head, "image"), "url"));

  const episodes = [];
  for (const it of items) {
    const enc = enclosureOf(it);
    if (!enc) continue; // an item without audio is a blog post, not an episode
    const published = Date.parse(textOf(firstTag(it, ["pubDate", "published", "updated"])));
    episodes.push({
      guid: textOf(tagContent(it, "guid")) || enc.url,
      title: textOf(tagContent(it, "title")).slice(0, 300) || "Untitled episode",
      description: textOf(
        firstTag(it, ["itunes:summary", "description", "content:encoded"])
      ).slice(0, 600),
      audioUrl: enc.url,
      bytes: enc.length,
      ext: extFor(enc.type, enc.url),
      duration: parseDuration(textOf(tagContent(it, "itunes:duration"))),
      publishedAt: Number.isFinite(published) ? published : 0,
    });
  }

  return {
    title: textOf(tagContent(head, "title")).slice(0, 300) || "Untitled feed",
    author: textOf(firstTag(head, ["itunes:author", "managingEditor"])).slice(0, 200),
    image,
    description: textOf(firstTag(head, ["description", "itunes:summary"])).slice(0, 600),
    episodes,
  };
}

/**
 * What the user pasted: a direct feed URL, or an Apple Podcasts page whose
 * numeric id can be turned into a feed URL through the iTunes lookup API.
 */
export function feedUrlFrom(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const apple = /podcasts\.apple\.com\/[^\s"']*\/?id(\d+)/i.exec(s);
  if (apple) return { apple: apple[1] };
  if (/^https?:\/\/\S+$/i.test(s)) return { url: s };
  return null;
}
