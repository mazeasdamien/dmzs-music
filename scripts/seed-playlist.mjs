/**
 * Fills a playlist from a JSON tracklist, over the app's own HTTP API.
 *
 *   node scripts/seed-playlist.mjs playlists/2010.json
 *
 * Deliberately not a D1 script: it talks to the Worker the way the extension
 * does, so it needs the activation key and nothing else — no Cloudflare API
 * token, no database permissions, and it works against production from
 * anywhere.
 *
 * Adding is idempotent. The playlist id is a hash of its name, the track id is
 * the YouTube id, and both inserts ignore conflicts, so re-running after a
 * half-finished pass costs nothing and duplicates nothing.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/seed-playlist.mjs <tracklist.json>");
  process.exit(1);
}

const APP_URL = (process.env.APP_URL || "https://music.agentxr.app").replace(/\/$/, "");
const KEY = process.env.BOOTSTRAP_KEY;
if (!KEY) {
  console.error("Set BOOTSTRAP_KEY (the same value you gave `wrangler secret put BOOTSTRAP_KEY`).");
  process.exit(1);
}

const { name, tracks } = JSON.parse(readFileSync(file, "utf8"));
if (!name || !Array.isArray(tracks)) {
  console.error("The file needs a { name, tracks: [{ id, title }] } shape.");
  process.exit(1);
}

/* One activation, reused for every call below. */
const authRes = await fetch(`${APP_URL}/auth/token?k=${encodeURIComponent(KEY)}`);
if (!authRes.ok) {
  console.error(`Activation refused (HTTP ${authRes.status}). Wrong BOOTSTRAP_KEY?`);
  process.exit(1);
}
const { token } = await authRes.json();

const call = (path, opts = {}) =>
  fetch(APP_URL + path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Session": token, ...(opts.headers || {}) },
  });

const plRes = await call("/api/playlists", {
  method: "POST",
  body: JSON.stringify({ name }),
});
if (!plRes.ok) {
  console.error(`Could not create "${name}" (HTTP ${plRes.status}): ${await plRes.text()}`);
  process.exit(1);
}
const { id: playlistId } = await plRes.json();
console.log(`Playlist "${name}" is ${playlistId}`);

/* Sequential on purpose. This is a one-off against a free-tier Worker, and a
   hundred parallel writes to the same two rows buy nothing but contention. */
let queued = 0, already = 0, failed = 0;
for (const [i, t] of tracks.entries()) {
  const label = `${String(i + 1).padStart(3)}/${tracks.length} ${t.title || t.id}`;
  try {
    const res = await call(`/api/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${t.id}`, title: t.title }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await res.json();
    if (out.queued) queued++;
    else already++;
    console.log(`${label} — ${out.queued ? "queued" : "already in the library"}`);
  } catch (e) {
    failed++;
    console.log(`${label} — FAILED (${e.message})`);
  }
}

console.log(`\n${queued} queued for download, ${already} already there, ${failed} failed.`);
if (queued) console.log("Start the downloader with `npm run dl` to fetch them.");
