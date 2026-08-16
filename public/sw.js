/**
 * Service worker, deliberately limited.
 *
 * WARNING: it NEVER intercepts /media/. That is on purpose.
 * Safari always sends a "Range: bytes=0-1" before reading an <audio>, and a
 * service worker answering 200 to that probe breaks playback silently.
 * Offline audio therefore goes through the Cache API, read from the page, and
 * then a blob: URL, which Safari handles natively with no fetch interception.
 *
 * All this file deals with is the app shell and the artwork (images, which do
 * not use Range requests).
 */

const SHELL = "dmzs-shell-v4";
const ART = "dmzs-art-v3";

// MUST match MEDIA_CACHE in index.html.
//
// This cache is created and filled by the page, never by this file, but the
// activate handler below deletes every cache that is not in KEEP. Leaving it
// out means each service worker update silently wipes every downloaded track,
// which is exactly what offline playback depends on. Keep it listed.
const MEDIA = "dmzs-media-v1";

const KEEP = [SHELL, ART, MEDIA];

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

  // Off-limits paths: let the network do its job.
  if (
    url.pathname.startsWith("/media/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/internal/") ||
    url.pathname === "/auth" ||
    url.pathname === "/logout"
  ) {
    return;
  }

  // Artwork: cache first, network second.
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

  // Navigation: network first, so updates come through, falling back to the
  // cached shell when offline.
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

  // Every other static file: cache first.
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
