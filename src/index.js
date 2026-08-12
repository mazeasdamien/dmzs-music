import {
  requestSession,
  renewedCookie,
  issueSession,
  sessionCookie,
  clearCookie,
  safeEqual,
  SESSION_TTL,
} from "./auth.js";
import { videoIdFrom, parseRange } from "./util.js";
import { parseFeed, feedUrlFrom, extFor } from "./feed.js";

export { videoIdFrom, parseRange };

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

// A job claimed but silent for this long goes back into the queue. Covers a
// power cut, a `docker stop` mid-download and a laptop lid being closed,
// without which the track would stay stuck in 'downloading' forever. Every
// progress report refreshes the lease, so a long download is never preempted.
const LEASE_MS = 15 * 60 * 1000;

const MIME = {
  ogg: 'audio/ogg; codecs="opus"',
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

/* ────────────────────────────────────────────────────────────────
   Serving from R2, with correct Range handling.

   Essential: Safari always sends a `Range: bytes=0-1` before reading an
   <audio>. Answering 200 to that probe breaks playback.
   ──────────────────────────────────────────────────────────────── */
async function serveObject(request, env, key, contentType) {
  const head = await env.MEDIA.head(key);
  if (!head) return new Response("Not found", { status: 404 });

  const size = head.size;
  const base = {
    // What was stored wins; the caller's type is the fallback. Podcast art
    // is whatever the feed served (JPEG, PNG…), and R2 remembers which.
    "Content-Type": head.httpMetadata?.contentType || contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: head.httpEtag,
  };

  const rangeHeader = request.headers.get("Range");

  if (!rangeHeader) {
    if (request.method === "HEAD") {
      return new Response(null, { headers: { ...base, "Content-Length": String(size) } });
    }
    const obj = await env.MEDIA.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: { ...base, "Content-Length": String(size) },
    });
  }

  const r = parseRange(rangeHeader, size);
  if (!r) {
    return new Response("Range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  const { start, end } = r;
  const length = end - start + 1;

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 206,
      headers: {
        ...base,
        "Content-Length": String(length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  const obj = await env.MEDIA.get(key, { range: { offset: start, length } });
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    status: 206,
    headers: {
      ...base,
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}

/* ────────────────────────────────────────────────────────────────
   Internal endpoints, called by the downloader and never by the browser.

   The downloader runs on a personal machine behind a home router, so the
   Worker cannot call it. It is the downloader that comes and fetches work
   (`/internal/next-job`). No port to open, no tunnel, no fixed IP.
   ──────────────────────────────────────────────────────────────── */
function internalAuthOk(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return Boolean(env.WORKER_TOKEN) && safeEqual(token, env.WORKER_TOKEN);
}

async function handleInternal(request, env, path) {
  if (!internalAuthOk(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = new URL(request.url);

  // Claims the next track to process. Returns {} when the queue is empty.
  if (path === "/internal/next-job" && request.method === "GET") {
    const now = Date.now();

    // Lease expired: the previous downloader stopped reporting in.
    await env.DB.prepare(
      `UPDATE tracks SET status = 'pending', claimed_at = NULL, progress = 0,
                         stage = 'Waiting for the downloader…'
         WHERE status = 'downloading' AND claimed_at IS NOT NULL AND claimed_at < ?`
    )
      .bind(now - LEASE_MS)
      .run();

    const row = await env.DB.prepare(
      "SELECT id FROM tracks WHERE status = 'pending' ORDER BY created_at LIMIT 1"
    ).first();
    if (!row) return json({});

    // The `status = 'pending'` guard makes claiming atomic: if two downloaders
    // poll at the same time, the second one sees changes = 0 and leaves empty
    // handed rather than processing the track twice.
    const claim = await env.DB.prepare(
      `UPDATE tracks SET status = 'downloading', claimed_at = ?, progress = 0,
                         stage = 'Analyzing…', error = NULL
         WHERE id = ? AND status = 'pending'`
    )
      .bind(now, row.id)
      .run();

    if (!claim.meta?.changes) return json({});

    return json({ id: row.id, url: `https://www.youtube.com/watch?v=${row.id}` });
  }

  // Progress, plus metadata discovered along the way.
  if (path === "/internal/progress" && request.method === "POST") {
    const b = await request.json();
    if (!b.id) return json({ error: "missing id" }, 400);

    // claimed_at doubles as a heartbeat: while progress happens, the lease runs.
    const sets = ["status = ?", "progress = ?", "stage = ?", "claimed_at = ?"];
    const vals = [
      b.status || "downloading",
      Math.round(b.progress ?? 0),
      b.stage || "",
      Date.now(),
    ];

    if (b.title) {
      sets.push("title = ?");
      vals.push(String(b.title).slice(0, 300));
    }
    if (b.artist !== undefined) {
      sets.push("artist = ?");
      vals.push(String(b.artist).slice(0, 200));
    }
    if (b.duration) {
      sets.push("duration = ?");
      vals.push(Math.round(b.duration));
    }

    vals.push(b.id);
    await env.DB.prepare(`UPDATE tracks SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals)
      .run();
    return json({ ok: true });
  }

  // Square artwork (raw JPEG in the body).
  if (path === "/internal/art" && request.method === "POST") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, 400);
    await env.MEDIA.put(`art/${id}.jpg`, request.body, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    return json({ ok: true });
  }

  // Final audio file (raw bytes) plus metadata in a header.
  if (path === "/internal/complete" && request.method === "POST") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, 400);

    let meta = {};
    try {
      const raw = request.headers.get("X-Meta");
      if (raw) {
        // atob() returns a latin1 string, so it has to go back through UTF-8,
        // otherwise "Café Tacvba" comes out as "CafÃ© Tacvba".
        const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
        meta = JSON.parse(new TextDecoder().decode(bytes));
      }
    } catch {
      return json({ error: "unreadable X-Meta" }, 400);
    }

    const ext = ["ogg", "m4a", "mp3"].includes(meta.ext) ? meta.ext : "ogg";
    const obj = await env.MEDIA.put(`audio/${id}.${ext}`, request.body, {
      httpMetadata: { contentType: MIME[ext] },
    });

    await env.DB.prepare(
      `UPDATE tracks SET
         title = COALESCE(NULLIF(?, ''), title),
         artist = ?, duration = ?, size = ?, codec = ?, ext = ?, bitrate = ?,
         status = 'ready', progress = 100, stage = '', error = NULL,
         claimed_at = NULL
       WHERE id = ?`
    )
      .bind(
        String(meta.title || "").slice(0, 300),
        String(meta.artist || "").slice(0, 200),
        Math.round(meta.duration || 0),
        obj?.size ?? 0,
        String(meta.codec || "").slice(0, 20),
        ext,
        Math.round(meta.bitrate || 0),
        id
      )
      .run();

    return json({ ok: true });
  }

  if (path === "/internal/fail" && request.method === "POST") {
    const b = await request.json();
    if (!b.id) return json({ error: "missing id" }, 400);
    // A track that fails before yt-dlp reports any metadata keeps the
    // placeholder title, so the row reads "Loading…" forever with no way to
    // tell which video it was. Fall back to the id, which is at least
    // identifiable and pasteable back into YouTube.
    await env.DB.prepare(
      `UPDATE tracks SET status = 'error', stage = '', claimed_at = NULL, error = ?,
                         title = CASE WHEN title = 'Loading…' THEN id ELSE title END
         WHERE id = ?`
    )
      .bind(String(b.error || "Unknown failure").slice(0, 500), b.id)
      .run();
    return json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

/* ────────────────────────────────────────────────────────────────
   Podcasts.

   An episode enclosure is a plain audio URL on a plain CDN, so the Worker
   fetches it itself and the downloader machine is never involved — no
   yt-dlp, nothing to circumvent. Everything below reuses the tracks
   playbook: a status column, an atomic claim, a lease that frees stuck
   work, R2 for the bytes.
   ──────────────────────────────────────────────────────────────── */

const FEED_UA = { "User-Agent": "dmzs-music/1.0 (personal podcast client)" };
const EP_LEASE_MS = 10 * 60 * 1000; // a fetch silent this long goes back in the queue
const EP_STREAM_MAX = 250 * 1024 * 1024; // cap when the host declares a size
const EP_BUFFER_MAX = 100 * 1024 * 1024; // cap when it does not (memory-bound)
const AUTO_QUEUE_MAX = 3; // new episodes fetched on their own per refresh

async function hashHex(s, len) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

const epKey = (id, ext) => `podcast/${id}.${ext}`;
const podArtKey = (id) => `podart/${id}.jpg`;

/** The user pasted either a feed URL or an Apple Podcasts page. */
async function resolveFeedUrl(input) {
  const ref = feedUrlFrom(input);
  if (!ref) throw new Error("Paste a feed URL or an Apple Podcasts link");
  if (ref.url) return ref.url;
  const res = await fetch(`https://itunes.apple.com/lookup?id=${ref.apple}&entity=podcast`, {
    headers: FEED_UA,
  });
  if (!res.ok) throw new Error("Apple's lookup did not answer");
  const data = await res.json().catch(() => null);
  const feedUrl = data?.results?.[0]?.feedUrl;
  if (!feedUrl) throw new Error("Apple knows no feed behind that link");
  return feedUrl;
}

async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    redirect: "follow",
    headers: { ...FEED_UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error(`The feed answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error("Feed too large");
  const feed = parseFeed(text);
  if (!feed) throw new Error("That URL did not return an RSS feed");
  if (!feed.episodes.length) throw new Error("No audio episodes in this feed");
  return feed;
}

/** Cover art, copied once into R2 so the app never hotlinks the feed's CDN. */
async function storePodArt(env, podId, imageUrl) {
  if (!imageUrl) return;
  try {
    const res = await fetch(imageUrl, { redirect: "follow", headers: FEED_UA });
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return; // a cover past 8 MB is not cover art
    await env.MEDIA.put(podArtKey(podId), buf, {
      httpMetadata: { contentType: res.headers.get("Content-Type") || "image/jpeg" },
    });
  } catch {}
}

/**
 * Inserts episodes the library has never seen. What downloads on its own:
 * on a fresh subscription, the latest episode; afterwards, only what is
 * genuinely newer than the library — the back-catalogue stays a tap away
 * rather than flooding R2.
 */
async function insertEpisodes(env, podId, feed) {
  const [knownRes, maxRes] = await env.DB.batch([
    env.DB.prepare("SELECT guid FROM episodes WHERE podcast_id = ?").bind(podId),
    env.DB.prepare("SELECT MAX(published_at) AS m FROM episodes WHERE podcast_id = ?").bind(podId),
  ]);
  const known = new Set((knownRes.results ?? []).map((r) => r.guid));
  const newestKnown = maxRes.results?.[0]?.m ?? null;

  const fresh = feed.episodes
    .filter((e) => !known.has(e.guid))
    .sort((a, b) => b.publishedAt - a.publishedAt);
  if (!fresh.length) return { added: 0, queued: 0 };

  const auto = new Set(
    (newestKnown === null ? fresh.slice(0, 1) : fresh.filter((e) => e.publishedAt > newestKnown))
      .slice(0, AUTO_QUEUE_MAX)
      .map((e) => e.guid)
  );

  const now = Date.now();
  const rows = [];
  for (const e of fresh) {
    rows.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO episodes
           (id, podcast_id, guid, title, description, audio_url, duration, size, ext,
            published_at, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        await hashHex(`ep|${podId}|${e.guid}`, 16),
        podId,
        e.guid,
        e.title,
        e.description,
        e.audioUrl,
        e.duration,
        0,
        e.ext,
        e.publishedAt,
        auto.has(e.guid) ? "queued" : "new",
        now
      )
    );
  }
  await env.DB.batch(rows);
  return { added: fresh.length, queued: auto.size };
}

async function refreshPodcast(env, pod) {
  try {
    const feed = await fetchFeed(pod.feed_url);
    await env.DB.prepare(
      `UPDATE podcasts SET title=?, author=?, image_url=?, description=?,
                           last_checked=?, last_error=NULL WHERE id=?`
    )
      .bind(feed.title, feed.author, feed.image, feed.description, Date.now(), pod.id)
      .run();
    if (feed.image && feed.image !== pod.image_url) await storePodArt(env, pod.id, feed.image);
    return await insertEpisodes(env, pod.id, feed);
  } catch (e) {
    await env.DB.prepare("UPDATE podcasts SET last_checked=?, last_error=? WHERE id=?")
      .bind(Date.now(), String((e && e.message) || e).slice(0, 300), pod.id)
      .run();
    return { added: 0, queued: 0 };
  }
}

async function fetchEpisode(env, row) {
  const res = await fetch(row.audio_url, {
    redirect: "follow",
    headers: { ...FEED_UA, Accept: "*/*" },
  });
  if (!res.ok || !res.body) throw new Error(`The audio host answered HTTP ${res.status}`);

  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  if (ct.includes("text/html")) throw new Error("Got a web page instead of audio");

  const ext = extFor(ct, row.audio_url) || row.ext || "mp3";
  const meta = { httpMetadata: { contentType: MIME[ext] || "audio/mpeg" } };
  const declared = Number(res.headers.get("Content-Length") || 0);
  if (declared > EP_STREAM_MAX) throw new Error("Episode past the 250 MB cap");

  let obj;
  if (declared > 0) {
    // R2 only accepts a stream whose size it knows up front; FixedLengthStream
    // is how a fetch body gets that label. The file never sits in memory, so
    // a two-hour episode costs the Worker nothing.
    const fixed = new FixedLengthStream(declared);
    res.body.pipeTo(fixed.writable).catch(() => {}); // failures resurface in put()
    obj = await env.MEDIA.put(epKey(row.id, ext), fixed.readable, meta);
  } else {
    // No Content-Length: buffered, with a hard cap, because Worker memory
    // is the ceiling here. Real podcast CDNs declare their sizes.
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > EP_BUFFER_MAX) {
        reader.cancel().catch(() => {});
        throw new Error("Episode past the 100 MB cap (host declares no size)");
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    obj = await env.MEDIA.put(epKey(row.id, ext), buf, meta);
  }
  return { size: obj?.size ?? declared, ext };
}

/**
 * Keeps at most `keep` stored episodes per show, evicting the oldest FETCHED
 * first — not the oldest published, so a back-catalogue episode fetched on
 * purpose is not thrown out the moment it arrives. Evicted rows go back to
 * 'new': the file leaves R2, the resume position stays.
 */
async function enforceRetention(env, podId) {
  const pod = await env.DB.prepare("SELECT keep FROM podcasts WHERE id=?").bind(podId).first();
  const keep = Math.max(1, Number(pod?.keep) || 5);
  const { results } = await env.DB.prepare(
    `SELECT id, ext FROM episodes WHERE podcast_id=? AND status='ready'
      ORDER BY fetched_at DESC`
  )
    .bind(podId)
    .all();
  const evict = (results ?? []).slice(keep);
  if (!evict.length) return;
  await env.MEDIA.delete(evict.map((e) => epKey(e.id, e.ext)));
  await env.DB.batch(
    evict.map((e) =>
      env.DB.prepare("UPDATE episodes SET status='new', size=0, fetched_at=NULL WHERE id=?").bind(
        e.id
      )
    )
  );
}

/**
 * Drains a little of the fetch queue. Called from a cron and, via
 * waitUntil(), right after any user action that queues something, so the
 * common case ("subscribe, hear it now") finishes in seconds while the cron
 * remains the backstop. Small batches on purpose: the free plan allows 50
 * subrequests per invocation, and each episode costs a handful.
 */
async function processEpisodeQueue(env, budgetMs = 20000, batch = 2) {
  const started = Date.now();

  // Lease expired: a waitUntil() that was cut short, a crashed cron run.
  await env.DB.prepare(
    `UPDATE episodes SET status='queued', claimed_at=NULL
       WHERE status='fetching' AND claimed_at IS NOT NULL AND claimed_at < ?`
  )
    .bind(Date.now() - EP_LEASE_MS)
    .run();

  for (let n = 0; n < batch; n++) {
    if (Date.now() - started > budgetMs) return;
    const row = await env.DB.prepare(
      `SELECT id, podcast_id, audio_url, ext FROM episodes
        WHERE status='queued' ORDER BY published_at DESC LIMIT 1`
    ).first();
    if (!row) return;

    // Same atomic claim as tracks: two concurrent passes, one winner.
    const claim = await env.DB.prepare(
      "UPDATE episodes SET status='fetching', claimed_at=?, error=NULL WHERE id=? AND status='queued'"
    )
      .bind(Date.now(), row.id)
      .run();
    if (!claim.meta?.changes) continue;

    try {
      const saved = await fetchEpisode(env, row);
      await env.DB.prepare(
        `UPDATE episodes SET status='ready', size=?, ext=?, fetched_at=?,
                             claimed_at=NULL, error=NULL WHERE id=?`
      )
        .bind(saved.size, saved.ext, Date.now(), row.id)
        .run();
      await enforceRetention(env, row.podcast_id);
    } catch (e) {
      await env.DB.prepare(
        "UPDATE episodes SET status='error', claimed_at=NULL, error=? WHERE id=?"
      )
        .bind(String((e && e.message) || e).slice(0, 500), row.id)
        .run();
    }
  }
}

/* ────────────────────────────────────────────────────────────────
   Public API (behind the cookie)
   ──────────────────────────────────────────────────────────────── */
async function handleApi(request, env, path, ctx) {
  // GET /api/tracks
  if (path === "/api/tracks" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id,title,artist,duration,size,codec,ext,bitrate,status,progress,stage,error,created_at,plays,fav
         FROM tracks ORDER BY created_at DESC`
    ).all();
    return json({ tracks: results ?? [] });
  }

  // POST /api/tracks  { url }
  if (path === "/api/tracks" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const id = videoIdFrom(body?.url);
    if (!id) return json({ error: "Unrecognized YouTube link" }, 400);

    const existing = await env.DB.prepare(
      "SELECT id, status FROM tracks WHERE id = ?"
    )
      .bind(id)
      .first();

    if (existing && existing.status === "ready") {
      return json({ id, duplicate: true }, 200);
    }

    // The track is simply queued. The downloader will claim it on its next
    // poll: nothing to wake up here, and adding from the phone stays instant
    // even when the machine is switched off.
    const STAGE = "Waiting for the downloader…";

    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO tracks (id,title,artist,status,stage,created_at)
         VALUES (?,?,?,'pending',?,?)`
      )
        .bind(id, "Loading…", "", STAGE, Date.now())
        .run();
    } else {
      // Retrying a track that failed.
      await env.DB.prepare(
        `UPDATE tracks SET status='pending', progress=0, stage=?,
                           claimed_at=NULL, error=NULL
           WHERE id = ?`
      )
        .bind(STAGE, id)
        .run();
    }

    return json({ id }, 202);
  }

  // POST /api/tracks/:id/play, one more play.
  // The client calls this once per track load, as soon as playback starts, and
  // never again for the same load: pausing, seeking and looping do not count.
  const played = path.match(/^\/api\/tracks\/([\w-]{11})\/play$/);
  if (played && request.method === "POST") {
    const r = await env.DB.prepare(
      "UPDATE tracks SET plays = plays + 1 WHERE id = ? AND status = 'ready'"
    )
      .bind(played[1])
      .run();
    return json({ ok: Boolean(r.meta?.changes) });
  }

  // POST /api/tracks/:id/fav  { fav: 0 | 1 }
  // Explicit value rather than a toggle: two devices tapping at once would
  // otherwise flip it twice and land back where they started.
  const fav = path.match(/^\/api\/tracks\/([\w-]{11})\/fav$/);
  if (fav && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const r = await env.DB.prepare("UPDATE tracks SET fav = ? WHERE id = ?")
      .bind(b.fav ? 1 : 0, fav[1])
      .run();
    return json({ ok: Boolean(r.meta?.changes) });
  }

  // DELETE /api/tracks/:id
  const del = path.match(/^\/api\/tracks\/([\w-]{11})$/);
  if (del && request.method === "DELETE") {
    const id = del[1];
    const row = await env.DB.prepare("SELECT ext FROM tracks WHERE id = ?").bind(id).first();
    if (row?.ext) await env.MEDIA.delete(`audio/${id}.${row.ext}`);
    await env.MEDIA.delete(`art/${id}.jpg`);
    await env.DB.prepare("DELETE FROM tracks WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  /* ── podcasts ── */

  // GET /api/podcasts — shows and episodes, one payload.
  if (path === "/api/podcasts" && request.method === "GET") {
    const [p, e] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id,title,author,image_url,description,keep,created_at,last_checked,last_error
           FROM podcasts ORDER BY title COLLATE NOCASE`
      ),
      env.DB.prepare(
        `SELECT id,podcast_id,title,description,duration,size,ext,published_at,status,error,position,played
           FROM episodes ORDER BY published_at DESC`
      ),
    ]);
    const episodes = e.results ?? [];
    // A fetch queue left behind by a closed tab restarts on the next open.
    if (ctx && episodes.some((x) => x.status === "queued" || x.status === "fetching")) {
      ctx.waitUntil(processEpisodeQueue(env, 20000, 2));
    }
    return json({ podcasts: p.results ?? [], episodes });
  }

  // POST /api/podcasts { url } — subscribe. The feed is read synchronously
  // (the user is told immediately when a URL is not a podcast); the latest
  // episode then downloads in the background.
  if (path === "/api/podcasts" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    let feedUrl, feed;
    try {
      feedUrl = await resolveFeedUrl(b?.url);
      feed = await fetchFeed(feedUrl);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 400);
    }
    const id = await hashHex(`pod|${feedUrl}`, 12);
    await env.DB.prepare(
      `INSERT INTO podcasts (id, feed_url, title, author, image_url, description, created_at, last_checked)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author,
         image_url=excluded.image_url, description=excluded.description,
         last_checked=excluded.last_checked, last_error=NULL`
    )
      .bind(id, feedUrl, feed.title, feed.author, feed.image, feed.description, Date.now(), Date.now())
      .run();
    const { added } = await insertEpisodes(env, id, feed);
    if (ctx) {
      ctx.waitUntil(storePodArt(env, id, feed.image));
      ctx.waitUntil(processEpisodeQueue(env, 25000, 2));
    }
    return json({ id, added }, 201);
  }

  // POST /api/podcasts/:id/refresh — re-read the feed right now.
  const podRefresh = path.match(/^\/api\/podcasts\/([a-f0-9]{12})\/refresh$/);
  if (podRefresh && request.method === "POST") {
    const pod = await env.DB.prepare(
      "SELECT id, feed_url, image_url FROM podcasts WHERE id=?"
    )
      .bind(podRefresh[1])
      .first();
    if (!pod) return json({ error: "Unknown podcast" }, 404);
    const r = await refreshPodcast(env, pod);
    if (ctx && r.queued) ctx.waitUntil(processEpisodeQueue(env, 25000, 2));
    return json(r);
  }

  // DELETE /api/podcasts/:id — unsubscribe, stored files included.
  const podDel = path.match(/^\/api\/podcasts\/([a-f0-9]{12})$/);
  if (podDel && request.method === "DELETE") {
    const id = podDel[1];
    const { results } = await env.DB.prepare(
      "SELECT id, ext FROM episodes WHERE podcast_id=? AND status='ready'"
    )
      .bind(id)
      .all();
    await env.MEDIA.delete([...(results ?? []).map((e) => epKey(e.id, e.ext)), podArtKey(id)]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM episodes WHERE podcast_id=?").bind(id),
      env.DB.prepare("DELETE FROM podcasts WHERE id=?").bind(id),
    ]);
    return json({ ok: true });
  }

  // POST /api/episodes/:id/fetch — pull one episode into R2 on demand.
  const epFetch = path.match(/^\/api\/episodes\/([a-f0-9]{16})\/fetch$/);
  if (epFetch && request.method === "POST") {
    const r = await env.DB.prepare(
      "UPDATE episodes SET status='queued', error=NULL WHERE id=? AND status IN ('new','error')"
    )
      .bind(epFetch[1])
      .run();
    if (r.meta?.changes && ctx) ctx.waitUntil(processEpisodeQueue(env, 25000, 2));
    return json({ ok: Boolean(r.meta?.changes) });
  }

  // POST /api/episodes/:id/state { position?, played? }
  // The resume point lives in D1 rather than on the device: picking up on
  // the phone where the desktop stopped is the whole point for podcasts.
  const epState = path.match(/^\/api\/episodes\/([a-f0-9]{16})\/state$/);
  if (epState && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const sets = [];
    const vals = [];
    if (b.position !== undefined) {
      sets.push("position = ?");
      vals.push(Math.max(0, Math.round(Number(b.position) || 0)));
    }
    if (b.played !== undefined) {
      sets.push("played = ?");
      vals.push(b.played ? 1 : 0);
    }
    if (!sets.length) return json({ error: "Nothing to update" }, 400);
    vals.push(epState[1]);
    const r = await env.DB.prepare(`UPDATE episodes SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals)
      .run();
    return json({ ok: Boolean(r.meta?.changes) });
  }

  // DELETE /api/episodes/:id — drop the stored file, keep the row. The
  // episode goes back to "fetchable", resume position included.
  const epDel = path.match(/^\/api\/episodes\/([a-f0-9]{16})$/);
  if (epDel && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT id, ext, status FROM episodes WHERE id=?")
      .bind(epDel[1])
      .first();
    if (!row) return json({ error: "Unknown episode" }, 404);
    if (row.status === "ready") await env.MEDIA.delete(epKey(row.id, row.ext));
    await env.DB.prepare(
      "UPDATE episodes SET status='new', size=0, fetched_at=NULL, claimed_at=NULL, error=NULL WHERE id=?"
    )
      .bind(row.id)
      .run();
    return json({ ok: true });
  }

  return json({ error: "Unknown route" }, 404);
}

/* ────────────────────────────────────────────────────────────────
   Entry point
   ──────────────────────────────────────────────────────────────── */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Internal endpoints: bearer token, no cookie.
    if (path.startsWith("/internal/")) {
      return handleInternal(request, env, path);
    }

    // 2. Activating a device: /auth?k=<BOOTSTRAP_KEY>
    if (path === "/auth") {
      const k = url.searchParams.get("k") || "";
      if (!env.BOOTSTRAP_KEY || !safeEqual(k, env.BOOTSTRAP_KEY)) {
        // Same response as any protected page: the route's existence is not
        // confirmed to a random visitor.
        return denied();
      }
      const token = await issueSession(env.AUTH_SECRET);
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": sessionCookie(token) },
      });
    }

    // 2b. Same activation, but for a client with no cookie (the Chrome
    // extension): the token is returned in the clear, to be stored client
    // side and then presented in the X-Session header.
    if (path === "/auth/token") {
      const k = url.searchParams.get("k") || "";
      if (!env.BOOTSTRAP_KEY || !safeEqual(k, env.BOOTSTRAP_KEY)) {
        return json({ error: "Invalid key" }, 401);
      }
      const token = await issueSession(env.AUTH_SECRET);
      return json({ token, expires_in: SESSION_TTL });
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": clearCookie() },
      });
    }

    // 3. Everything else requires a valid session.
    const session = await requestSession(request, env);
    if (!session) {
      return denied();
    }

    if (path.startsWith("/api/")) {
      // The only route where the activation is extended: the app calls it on
      // every open, and this leaves /media/ 206 responses alone, where
      // rewriting a response just for one header would be a needless risk.
      const res = await handleApi(request, env, path, ctx);
      const fresh = await renewedCookie(session, env);
      if (!fresh) return res;
      const out = new Response(res.body, res);
      out.headers.append("Set-Cookie", fresh);
      return out;
    }

    const media = path.match(/^\/media\/([\w-]{11})$/);
    if (media) {
      const row = await env.DB.prepare("SELECT ext FROM tracks WHERE id = ? AND status = 'ready'")
        .bind(media[1])
        .first();
      if (!row) return new Response("Not found", { status: 404 });
      return serveObject(request, env, `audio/${media[1]}.${row.ext}`, MIME[row.ext] || "audio/ogg");
    }

    const mediaEp = path.match(/^\/media\/ep\/([a-f0-9]{16})$/);
    if (mediaEp) {
      const row = await env.DB.prepare(
        "SELECT ext FROM episodes WHERE id = ? AND status = 'ready'"
      )
        .bind(mediaEp[1])
        .first();
      if (!row) return new Response("Not found", { status: 404 });
      return serveObject(request, env, epKey(mediaEp[1], row.ext), MIME[row.ext] || "audio/mpeg");
    }

    const art = path.match(/^\/art\/([\w-]{11})$/);
    if (art) {
      return serveObject(request, env, `art/${art[1]}.jpg`, "image/jpeg");
    }

    const podArt = path.match(/^\/art\/pod\/([a-f0-9]{12})$/);
    if (podArt) {
      return serveObject(request, env, podArtKey(podArt[1]), "image/jpeg");
    }

    // 4. Otherwise: static files (the PWA).
    return env.ASSETS.fetch(request);
  },

  // Podcast upkeep. Each pass re-reads a few feeds (each feed at most once
  // an hour) and drains a couple of queued episodes; the next pass picks up
  // where this one stopped. Deliberately small: the free plan allows 50
  // subrequests per invocation, and patience is free.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const { results } = await env.DB.prepare(
          `SELECT id, feed_url, image_url FROM podcasts
            WHERE last_checked IS NULL OR last_checked < ? LIMIT 5`
        )
          .bind(Date.now() - 55 * 60 * 1000)
          .all();
        for (const pod of results ?? []) await refreshPodcast(env, pod);
        await processEpisodeQueue(env, 5 * 60 * 1000, 2);
      })()
    );
  },
};

function denied() {
  // A flat 401, never a redirect: an <audio> or a fetch() then gets an error
  // it can act on, instead of an HTML page dressed up as an audio file.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access denied</title>
<style>
 html,body{height:100%;margin:0}
 body{background:#09090b;color:#8b8b93;display:flex;align-items:center;justify-content:center;
      font:400 15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;padding:24px}
 strong{display:block;color:#f4f4f5;font-size:17px;font-weight:600;margin-bottom:6px}
</style></head>
<body><div><strong>Access denied</strong>This device is not activated.</div></body></html>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
