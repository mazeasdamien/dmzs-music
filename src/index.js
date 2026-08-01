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
    "Content-Type": contentType,
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
    await env.DB.prepare(
      "UPDATE tracks SET status = 'error', stage = '', claimed_at = NULL, error = ? WHERE id = ?"
    )
      .bind(String(b.error || "Unknown failure").slice(0, 500), b.id)
      .run();
    return json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

/* ────────────────────────────────────────────────────────────────
   Public API (behind the cookie)
   ──────────────────────────────────────────────────────────────── */
async function handleApi(request, env, path) {
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
  // The client only calls this after 20 s of actual playback: skipping through
  // ten tracks must not count as ten plays.
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

  return json({ error: "Unknown route" }, 404);
}

/* ────────────────────────────────────────────────────────────────
   Entry point
   ──────────────────────────────────────────────────────────────── */
export default {
  async fetch(request, env) {
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
      const res = await handleApi(request, env, path);
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

    const art = path.match(/^\/art\/([\w-]{11})$/);
    if (art) {
      return serveObject(request, env, `art/${art[1]}.jpg`, "image/jpeg");
    }

    // 4. Otherwise: static files (the PWA).
    return env.ASSETS.fetch(request);
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
