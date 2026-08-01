/**
 * Service worker — volontairement limité.
 *
 * ⚠️ Il n'intercepte JAMAIS /media/. C'est délibéré.
 * Safari envoie toujours un « Range: bytes=0-1 » avant de lire un <audio>.
 * Un service worker qui répond 200 à cette sonde casse la lecture en silence.
 * L'audio hors-ligne passe donc par l'API Cache lue depuis la page, puis par
 * une URL blob: — que Safari gère nativement, sans interception fetch.
 *
 * Ici on ne s'occupe que de la coque de l'app et des pochettes (des images,
 * qui n'utilisent pas de requêtes Range).
 */

const SHELL = "dmzs-shell-v3";
const ART = "dmzs-art-v3";
const KEEP = [SHELL, ART];

const SHELL_FILES = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Zones interdites : on laisse le réseau faire son travail.
  if (
    url.pathname.startsWith("/media/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/internal/") ||
    url.pathname === "/auth" ||
    url.pathname === "/logout"
  ) {
    return;
  }

  // Pochettes : cache d'abord, réseau ensuite.
  if (url.pathname.startsWith("/art/")) {
    event.respondWith(
      caches.open(ART).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return new Response("", { status: 504 });
        }
      })
    );
    return;
  }

  // Navigation : réseau d'abord (pour récupérer les mises à jour), repli
  // sur la coque en cache quand on est hors ligne.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(async () => (await caches.match("/")) || new Response("Offline", { status: 503 }))
    );
    return;
  }

  // Reste des fichiers statiques : cache d'abord.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
    )
  );
});
