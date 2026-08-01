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

// Un job réservé mais sans signe de vie depuis ce délai est remis en file.
// Couvre la panne de courant, le `docker stop` en plein téléchargement et le
// portable qu'on referme — sans quoi le titre resterait bloqué en
// « downloading » pour toujours. Chaque rapport d'avancement rafraîchit le bail,
// donc un long téléchargement ne se fait jamais préempter.
const LEASE_MS = 15 * 60 * 1000;

const MIME = {
  ogg: 'audio/ogg; codecs="opus"',
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

/* ────────────────────────────────────────────────────────────────
   Diffusion depuis R2, avec gestion correcte des requêtes Range.

   Indispensable : Safari envoie systématiquement un `Range: bytes=0-1`
   avant de lire un <audio>. Répondre 200 à cette sonde casse la lecture.
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
   Endpoints internes — appelés par le téléchargeur, jamais par le navigateur.

   Le téléchargeur tourne sur une machine perso, derrière une box : le Worker
   ne peut pas l'appeler. C'est donc lui qui vient chercher le travail
   (`/internal/next-job`). Aucun port à ouvrir, aucun tunnel, aucune IP fixe.
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

  // Réclame le prochain titre à traiter. Renvoie {} quand la file est vide.
  if (path === "/internal/next-job" && request.method === "GET") {
    const now = Date.now();

    // Bail expiré : le téléchargeur précédent n'a plus donné signe de vie.
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

    // Le garde `status = 'pending'` rend la réservation atomique : si deux
    // téléchargeurs sondent en même temps, le second voit changes = 0 et
    // repart les mains vides plutôt que de traiter le titre en double.
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

  // Avancement + métadonnées découvertes en cours de route.
  if (path === "/internal/progress" && request.method === "POST") {
    const b = await request.json();
    if (!b.id) return json({ error: "missing id" }, 400);

    // claimed_at sert de battement de cœur : tant que ça avance, le bail court.
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

  // Vignette carrée (JPEG brut dans le corps).
  if (path === "/internal/art" && request.method === "POST") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, 400);
    await env.MEDIA.put(`art/${id}.jpg`, request.body, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    return json({ ok: true });
  }

  // Fichier audio final (octets bruts) + métadonnées en en-tête.
  if (path === "/internal/complete" && request.method === "POST") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, 400);

    let meta = {};
    try {
      const raw = request.headers.get("X-Meta");
      if (raw) {
        // atob() rend une chaîne latin1 : il faut repasser par UTF-8,
        // sinon « Café Tacvba » ressort en « CafÃ© Tacvba ».
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
   API publique (derrière le cookie)
   ──────────────────────────────────────────────────────────────── */
async function handleApi(request, env, path) {
  // GET /api/tracks
  if (path === "/api/tracks" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id,title,artist,duration,size,codec,ext,bitrate,status,progress,stage,error,created_at,plays
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

    // Le titre est simplement déposé en file. Le téléchargeur le réclamera à
    // son prochain sondage : rien à réveiller ici, et l'ajout depuis le
    // téléphone reste instantané même si la machine est éteinte.
    const STAGE = "Waiting for the downloader…";

    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO tracks (id,title,artist,status,stage,created_at)
         VALUES (?,?,?,'pending',?,?)`
      )
        .bind(id, "Loading…", "", STAGE, Date.now())
        .run();
    } else {
      // Relance d'un titre en erreur.
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

  // POST /api/tracks/:id/play — une écoute de plus.
  // Le client n'appelle qu'après 20 s de lecture effective : sauter dix titres
  // ne doit pas les compter comme dix écoutes.
  const played = path.match(/^\/api\/tracks\/([\w-]{11})\/play$/);
  if (played && request.method === "POST") {
    const r = await env.DB.prepare(
      "UPDATE tracks SET plays = plays + 1 WHERE id = ? AND status = 'ready'"
    )
      .bind(played[1])
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
   Entrée
   ──────────────────────────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Endpoints internes : jeton porteur, pas de cookie.
    if (path.startsWith("/internal/")) {
      return handleInternal(request, env, path);
    }

    // 2. Activation d'un appareil : /auth?k=<BOOTSTRAP_KEY>
    if (path === "/auth") {
      const k = url.searchParams.get("k") || "";
      if (!env.BOOTSTRAP_KEY || !safeEqual(k, env.BOOTSTRAP_KEY)) {
        // Même réponse qu'une page protégée : on ne confirme pas
        // l'existence de la route à un visiteur au hasard.
        return denied();
      }
      const token = await issueSession(env.AUTH_SECRET);
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": sessionCookie(token) },
      });
    }

    // 2 bis. Même activation, mais pour un client sans cookie (l'extension
    // Chrome) : on renvoie le jeton en clair, à ranger côté client et à
    // présenter ensuite dans l'en-tête X-Session.
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

    // 3. Tout le reste exige une session valide.
    const session = await requestSession(request, env);
    if (!session) {
      return denied();
    }

    if (path.startsWith("/api/")) {
      // Seule route où l'on prolonge l'activation : l'app l'appelle à chaque
      // ouverture, et on ne touche pas aux réponses 206 de /media/, où
      // réécrire la réponse pour un en-tête serait un risque inutile.
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

    // 4. Sinon : fichiers statiques (la PWA).
    return env.ASSETS.fetch(request);
  },
};

function denied() {
  // 401 franc, jamais de redirection : un <audio> ou un fetch() reçoit une
  // erreur exploitable au lieu d'une page HTML déguisée en fichier audio.
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
