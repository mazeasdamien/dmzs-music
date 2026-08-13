# dmzs-music

A personal music library that runs on Cloudflare's free tier. Tracks are added
from the browser extension, fetched at the best available quality, stored in
the cloud, and played from a PWA pinned to your iPhone home screen, online or
offline.

The app itself has no field for pasting links: adding is what the extension is
for, and the phone is only ever used for listening.

**Running cost: $0.** Everything fits inside Cloudflare's free allowances.

---

## Legal and licence, before anything else

**Licence: [MIT](LICENSE).** Free to use, copy, modify and redistribute, as
long as the copyright notice stays in place. No warranty of any kind.

**Legal. Read this before using it: what this project does is not clearly
lawful, and in the EU there is binding case law against it.**

Three separate layers, worth keeping apart.

*The tool itself is lawful.* yt-dlp is not illegal software. The DMCA takedown
filed by the RIAA against youtube-dl in 2020 was reversed by GitHub after the
EFF intervened.

*Downloading breaches YouTube's terms of service.* That is contractual, not
criminal. The realistic consequence is account or access termination.

*Copyright is the real problem.* Most EU countries have a private-copying
exception, France included, which is where the author of this repository lives
and where this project was built. That exception does **not** cover
circumventing a technological protection measure (Article 6 of the InfoSoc
Directive; Article L331-5 of the French Intellectual Property Code), so it does
not cover what this project does. In November 2024 the Hamburg
Higher Regional Court upheld, finally and without further appeal, that
YouTube's "rolling cipher" is an effective technological protection measure and
that youtube-dl circumvents it. That is the most directly applicable European
precedent for what this project does.

For the avoidance of doubt: the CJEU ruling of 16 April 2026 (C-496/24,
*Stichting de Thuiskopie v HP Nederland*) is sometimes cited here, but it
concerns something else. It holds that DRM-locked offline downloads offered by
streaming services themselves are not private copies for private-copying levy
purposes. It does not address copies a user makes with their own tool.

This project is published for personal and educational use. You are responsible
for what you do with it and for the rights attached to the content you
download. This is not legal advice; for anything beyond strictly personal use,
talk to a lawyer.

---

<p align="center">
  <img src="docs/library.png" alt="Library view on iPhone" width="45%">
  <img src="docs/now-playing.png" alt="Now playing view on iPhone" width="45%">
</p>

The Chrome extension adds an **Add to Music** button straight into YouTube's
action row, next to *Subscribe*. One click and the track is queued:

<p align="center">
  <img src="docs/extension-button.png" alt="Add to Music button on a YouTube page" width="90%">
</p>

```
iPhone ──► Worker ──► checks the cookie, writes a row in D1, and stops there
                          ▲
Your machine ─────────────┘  "any work?"  (polls every 30 s)
     └──► yt-dlp → remux → uploads the file back to the Worker → R2
iPhone ◄── Worker ◄── serves audio from R2 (with Range support)
```

| Piece | Role |
|---|---|
| Worker | API, auth, audio delivery, static files |
| Downloader | yt-dlp + ffmpeg + Deno, on your machine, the only part that runs binaries |
| R2 | audio files and artwork (10 GB free ≈ 1,500 tracks) |
| D1 | library metadata |

---

## Using the app

The library is deliberately thin. It is a listening surface, not a manager.

- **Tap a track** to play it. There is no Play button: the row is the button.
- **Shuffle** plays the visible list in random order.
- **Recent / Most played** reorders the library.
- **Favourites** narrows it to starred tracks.
- **Mixes** holds everything over ten minutes, and the library holds the rest.
  A mix picks up where it was left; a song always starts at the top.
- **Swipe a row left** to star it, **right** to unstar it.
- **Drag along the top of the mini bar** to move through the track without
  opening the full-screen player.
- **The magnifier** reveals the search field; closing it clears the query.
- **The download button** carries a badge with how many tracks are not yet on
  this device, and pulls them all down when tapped. Tap again to stop.

Ordering and filtering are not view-only. The sort pill, the favourites pill
and the search box all change what the library returns, and the play queue is
built from that same list. Choosing "Most played" therefore plays from most to
least played; turning on "Favourites" plays only those. There is no separate
"play this selection" path to disagree with what is on screen.

The ten-minute line exists because a DJ set, a live recording or an album
uploaded as one video is already a playlist of its own, and one of them landing
in a shuffle stops the listening dead for an hour. They are not hidden, they
are somewhere else: the **Mixes** pill swaps the library for them, and the
queue follows, so shuffling from there shuffles sets and nothing else. Search
is the one place that ignores the split and looks through everything, because
refusing to find a mix by name would read as the track having been lost. A
track that is still downloading has no duration yet and therefore counts as a
song; a long one moves across once the downloader reports its length.

Mixes also remember where they were left, songs do not. Restarting a
three-minute song costs three minutes; restarting an hour-long set is the
difference between the feature being usable and not. The position lives on the
device rather than in D1: where the phone stopped listening is not where the
desktop stopped, and a single shared value would have them overwrite each
other. The first and last minute are never stored, being indistinguishable from
the start and the end.

A **playlist** gets a pill of its own, after the fixed ones. Tapping it swaps
the library for that list, in the order the list was written rather than any
order the library could derive — which is the whole reason playlists exist
here, since Recent, Most played and Mixes all take their order from the tracks
themselves. The queue follows, as everywhere else.

Two rules keep a playlist from being a fourth kind of filter. The ten-minute
split does not apply inside one: a set put in a list on purpose belongs in that
list, so opening a playlist and opening Mixes take turns rather than stack. And
search stays inside the open playlist, unlike everywhere else, because in a
named list "no results" has to mean "not in this list" — leaving the playlist
is how you search the rest.

Membership is edited from the **⋮ menu** on any row, which lists every playlist
with a tick against the ones the track is already in, and takes the name of a
new one. Removing a track from a playlist is not deleting it; deleting it from
the library does remove it from every playlist. Re-adding appends, so a track
taken out and put back lands at the end.

In the full-screen player: **swipe down** to close, **left and right** to
change track, the **heart** stars what is playing, and the **repeat button**
cycles off → whole queue → this track forever.

New tracks download to the device on their own, so the library is offline
without being told. That stops by itself if the device runs out of space,
rather than retrying a doomed download on every poll.

---

## Podcasts

The **Podcasts** pill swaps the library for your subscriptions. It is the one
place the app accepts a pasted link, because there is no better way to hand
over an RSS URL — either the feed itself or a link to the show's page on Apple
Podcasts (the numeric id in that link resolves to the feed through Apple's
public lookup, one request, no key).

Podcasts do not touch the downloader, yt-dlp or the legal thicket above. An
episode enclosure is a plain audio file on a plain CDN: the Worker fetches it
itself, streams it straight into R2 without holding it in memory, and serves
it back with the same Range handling as tracks. The machinery mirrors the
tracks table on purpose — a status column, an atomic claim, a lease that
returns stuck work to the queue — so anyone who has read one flow has read
both.

What downloads on its own is deliberately narrow: the latest episode when you
subscribe, and anything genuinely newer that appears afterwards (a cron
re-reads each feed hourly). The back-catalogue stays listed but not stored —
tap an old episode and it is fetched on demand. R2 keeps the last **5**
fetched episodes per show (the `keep` column in D1, per show, no UI on
purpose), evicting the oldest *fetched* rather than the oldest *published*,
so a back-catalogue episode you asked for is not thrown out the moment it
arrives. Evicted episodes keep their row, and their resume position with it.

Listening works like everything else here: tap to play, episodes cache to the
device with the same Download entry, and they play offline through the same
blob: path. Two things exist only for podcasts. The resume position is stored
in **D1**, not on the device — unlike a mix, an episode is one continuous
listen that hops between phone and desktop, so the bigger of the two positions
wins and follows you. And the player header grows a **speed button** (1× to
2×) that applies to episodes and never to music. Finishing an episode marks it
played; the overflow menu can do it by hand, fetch or evict a stored copy, or
unsubscribe (which removes the show's files from R2 too).

If you are updating an existing deployment: the new tables ship in the same
`schema.sql`, everything in it is `CREATE TABLE IF NOT EXISTS`, so it is one
`npm run db:schema` followed by `npx wrangler deploy` — the deploy also
installs the cron from `wrangler.jsonc` that keeps feeds fresh. The same is
true of the `playlists` tables.

---

## Filling a playlist from a tracklist

Adding a hundred tracks through the extension, one YouTube page at a time, is
not a thing anyone will do. `scripts/seed-playlist.mjs` takes a JSON file and
does it in one pass:

```bash
BOOTSTRAP_KEY=... node scripts/seed-playlist.mjs playlists/2010.json
```

```json
{ "name": "2010", "tracks": [{ "id": "dQw4w9WgXcQ", "title": "Artist - Title" }] }
```

The `id` is the YouTube video id. `title` is only a placeholder, shown until
the downloader reports the real one — worth setting, because a hundred rows all
reading "Loading…" is a list you cannot check while it fills.

It talks to the Worker over HTTPS exactly as the extension does, so it needs
the activation key and nothing else: no Cloudflare API token, no database
permissions, and it works against production from anywhere. Every insert
ignores conflicts, so re-running after a half-finished pass costs nothing and
duplicates nothing.

To turn "Artist - Title" lines into video ids in the first place, yt-dlp's own
search does it without an API key, and it is already installed next to the
downloader:

```bash
downloader/.venv/Scripts/python -m yt_dlp --flat-playlist --print id "ytsearch1:Avicii - Levels"
```

`--flat-playlist` keeps it to the search results page, so a hundred lookups
cost a hundred cheap requests rather than a hundred watch pages. The module
form rather than the `yt-dlp` console script: the wrapper exits silently under
some shells on Windows, and `python -m` never does.

---

## Why the downloader pulls instead of being pushed to

This is the load-bearing decision of the project, and it solves two problems at
once.

A Worker **cannot call** a machine sitting behind a home router: no fixed IP, no
open port. Rather than punching a tunnel through, the direction of the call is
reversed: your machine asks the Worker for work.

```
Push    Worker ──► Downloader    needs a tunnel, a reachable IP, an open port
Pull    Worker ◄── Downloader    no inbound, nothing exposed   ← what this does
```

1. **It is free.** Running the downloader on Cloudflare would mean Containers,
   which have no free tier at all and require the Workers Paid plan ($5/month).
   Here, nothing runs on Cloudflare.
2. **It works.** Containers egress from Cloudflare IPs (AS13335), precisely what
   YouTube's anti-bot filtering targets. Your home connection has a residential
   IP, exactly what gets through where a datacenter IP does not. The problem
   isn't worked around, it stops existing.

**The trade-off:** your machine has to be running for a track to download. You
add tracks from the extension whenever you come across them, they sit in the
queue and start on the next boot. Playback doesn't depend on it: files live in
R2 and are served by the Worker.

A Raspberry Pi left on removes the constraint entirely for about 3 W.

---

## Requirements

- Node 20+
- A Cloudflare account, **the free plan is enough**
- A domain on that account with **Cloudflare nameservers active**. A Worker
  requires it (Pages doesn't, but Pages is feature-frozen).
- For the downloader: Python 3.12+, ffmpeg and Deno, or just Docker

> Deno is not optional. Since yt-dlp 2025.11.12 a JavaScript runtime is required
> to solve YouTube's n-sig challenges. Without one, yt-dlp silently loses half
> the audio formats.

---

## Setup

### 1. Pick your domain

The repository ships with `music.example.com` as a placeholder. Replace it in
**four** places:

| File | What to change |
|---|---|
| `wrangler.jsonc` | `routes[0].pattern` and `vars.APP_URL` |
| `extension/manifest.json` | `host_permissions` |
| `extension/shared.js` | `DEFAULT_APP_URL` |

The downloader reads its address from the environment, so nothing to edit there.

### 2. Install and log in

```bash
npm install
```

```bash
npx wrangler login
```

### 3. Create the database and the bucket

```bash
npx wrangler d1 create dmzs-music
```

```bash
npx wrangler r2 bucket create dmzs-music
```

Paste the printed `database_id` into `wrangler.jsonc`, replacing
`REPLACE_AFTER_CREATION`. Then create the tables:

```bash
npm run db:schema
```

> Keep the `DB` and `MEDIA` binding names. Wrangler suggests different ones in
> its output; the code uses these.

### 4. Generate the secrets

```bash
node scripts/secrets.mjs
```

It prints three secrets, the `wrangler secret put` commands to run, and **your
activation link**. Keep that output: the link is what grants access.

| Secret | Role |
|---|---|
| `AUTH_SECRET` | signs the session cookie |
| `BOOTSTRAP_KEY` | the key inside the activation link |
| `WORKER_TOKEN` | authenticates the downloader against the Worker |

Pass your domain as an argument to get the link right the first time:

```bash
node scripts/secrets.mjs music.yourdomain.com
```

### 5. Deploy

```bash
npx wrangler deploy
```

A few seconds: the Worker ships no container image, it is plain JavaScript and
static assets. The DNS record for the subdomain is created for you.

### 6. Activate your devices

Open the activation link from step 4 on each device:

```
https://music.yourdomain.com/auth?k=<BOOTSTRAP_KEY>
```

A signed cookie valid for **5 years** is set. Nothing to type again. Every other
visitor gets a flat 401.

> Chrome caps every cookie at 400 days regardless of what the server asks for;
> Safari does not apply that cap to server-set `HttpOnly` cookies. The Worker
> therefore re-issues the cookie once it is older than 30 days, on `/api/`
> requests. A device that opens the app at least once a year never needs
> re-activating, Chrome included.

### 7. Pin it on iOS

Safari → Share → **Add to Home Screen**. Still manual on iOS, there is no
install button.

<p align="center">
  <img src="docs/ios-share-sheet.png" alt="iOS share sheet" width="42%">
  <img src="docs/ios-add-to-home.png" alt="Add to Home Screen dialog" width="42%">
</p>

> A pinned app gets **its own storage container**, separate from Safari. The
> activation cookie does not carry over: open the activation link **a second
> time from inside the installed app**, or it will show "Access denied". Same
> for offline downloads: they belong to the installed app, not to Safari.

### 8. Start the downloader

**Windows, without Docker** (Python, ffmpeg and Deno on `PATH`):

```bash
npm run dl
```

It asks for your `WORKER_TOKEN` once, stores it in `downloader/.env` (git
ignored), creates a virtualenv, installs yt-dlp and starts polling. Put your
`APP_URL` in that same `.env` file to override the default.

**With Docker**, anywhere:

```bash
docker build -t dmzs-dl ./downloader
```

```bash
docker run -d --restart unless-stopped --name dmzs-dl -e APP_URL=https://music.yourdomain.com -e WORKER_TOKEN=<your WORKER_TOKEN> dmzs-dl
```

No published port: the container only makes outbound requests. You should see:

```
[boot] polling https://music.yourdomain.com every 30 s
[poll] queue empty, waiting
```

Queued tracks then drain back to back:

<p align="center">
  <img src="docs/downloader.png" alt="Downloader draining the queue" width="80%">
</p>

The image builds as-is on a Raspberry Pi (ARM64).

---

## Chrome extension

Adds the YouTube track you are watching without copying links around.

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the extension icon, paste your **full activation link**, then
   **Connect**

Three ways to add a track:

- The **"Add to Music" button** injected into YouTube's action row, next to
  *Subscribe*. It turns green once the track is queued.
- The **extension icon** → *Add this track*
- **Right-click → Add to Music**, on the page or on any YouTube link. A badge
  confirms: `✓` added, `=` already there, `!` failed.

<p align="center">
  <img src="docs/extension-added.png" alt="The button after adding a track" width="58%">
  <img src="docs/extension-popup.png" alt="Extension popup" width="34%">
</p>

Pasting the whole activation link rather than just the key also configures the
server address.

**Why a token and not the cookie.** An extension request is *cross-site* and the
session cookie is `SameSite=Lax`, so it would not be sent. The extension trades
the activation key for a token once via `/auth/token`, keeps it in
`chrome.storage.local`, and presents it in the `X-Session` header. It is the
same signed object as the cookie, with the same lifetime.

This opens no CSRF hole: a third-party site cannot set a custom header on a
cross-origin request, and the Worker serves no permissive CORS rules. Only an
extension holding the host permission can do it, which requires you to install
it explicitly.

The injected content script never calls the Worker itself; it goes through the
extension's service worker. That is what avoids requesting a host permission on
`youtube.com`, so the extension cannot read anything from your pages.

---

## Downloader settings

All through environment variables.

| Variable | Default | Role |
|---|---|---|
| `APP_URL` | none | public URL of the Worker (required) |
| `WORKER_TOKEN` | none | shared secret (required) |
| `POLL_INTERVAL` | `30` | seconds between empty polls |
| `BOT_COOLDOWN` | `1800` | seconds to stop asking after YouTube blocks the IP |
| `YT_COOKIES` | none | Netscape-format cookies, if anti-bot kicks in |
| `YT_PROXY` | none | `http://user:pass@host:port` |

On `POLL_INTERVAL`: 30 s is 2,880 requests/day, negligible against the free
tier's 100,000/day. Dropping to 1 s would burn 86,400 for nothing: the download
itself takes about thirty seconds, the wait is invisible. When a track does
start, polling doesn't wait: a queue of several tracks drains back to back.

### If a download gets stuck

A track claimed but silent for **15 minutes** is put back in the queue on the
next poll. That covers a power cut, a `docker stop` mid-download, and a laptop
lid being closed. Every progress report refreshes the lease, so a long download
is never preempted.

Claiming is atomic: `UPDATE ... WHERE id = ? AND status = 'pending'`, then the
Worker checks `changes`. You can run two downloaders (a PC and a Pi) with no
risk of duplicates.

---

## If YouTube blocks you

With a residential IP this is unlikely: it was the number one risk of the
earlier architecture, which egressed from Cloudflare IPs. If you do see
"YouTube blocked the request":

**a. Slow down.** The downloader already serialises tracks and sleeps between
requests, and it now stops asking for half an hour once a block is reported.
That pause matters: without it the loop went straight to the next job, failed
it the same way, and turned one block into a queue-wide wipeout in under a
minute. If you just queued thirty tracks, give it a few hours and retry them.

**b. A residential proxy**, mostly useful if you run the image on a VPS rather
than at home. Set `YT_PROXY`.

**c. Account cookies**, effective but carrying a real risk: YouTube can
restrict the account for hours or months. **Use a throwaway account, never your
main one.**

Correct export procedure (otherwise cookie rotation invalidates the file within
hours): private window → sign in → in the **same tab**, go to
`youtube.com/robots.txt` → export cookies in Netscape format → **close the
window without reopening the session**. Pass the contents in `YT_COOKIES`.

> Send the **files** through R2, not through a tunnel from your machine. Serving
> large media across the Cloudflare CDN from a personal server falls outside the
> terms of service; from R2 it is explicitly allowed. That is already what the
> code does: your machine POSTs to the Worker, which puts to R2.

---

## Design notes

**No re-encoding.** YouTube serves Opus at ~160 kb/s at best (itag 251).
Transcoding that to MP3 320 would be a pure loss for a file twice the size. The
downloader only swaps the container: the audio bytes are copied as-is.

**Opus in `.ogg`, not `.webm`.** Safari plays Opus **only** inside an Ogg
container, and only since iOS 18.4. Not in WebM, not in MP4. When the source is
AAC, an `.m4a` with `+faststart` is produced so playback starts without
downloading the whole file.

**Offline audio does not go through the service worker.** Safari probes every
`<audio>` with `Range: bytes=0-1`; a service worker answering 200 breaks
playback silently. Files are stored in the Cache API, read back as a `Blob` and
played from a `blob:` URL, which Safari handles natively. The service worker
only deals with the app shell and artwork.

**The library list is stored locally too.** The audio lives in the Cache API,
but the list of what exists only comes from `/api/tracks`, which the service
worker deliberately does not intercept. Without a local copy of that list the
app opens on a plane and shows an empty library, with every file sitting right
there on the device. The last successful response is therefore kept in
`localStorage` and used as a fallback.

**The media cache is listed in the service worker's `KEEP` array.** It is
created by the page, not by the worker, and the activate handler deletes every
cache that is not in `KEEP`. Leaving it out makes each service worker update
wipe every downloaded track.

**One `<audio>` element, never Web Audio.** `AudioContext` is suspended in the
background on iOS, which would kill lock-screen playback. A single element
"blessed" by the first user gesture can then chain tracks, including from the
`ended` event.

**No auth redirect, ever.** An invalid session returns a flat 401. Redirecting
to a login page would hand HTML to `<audio src>`, which then fails with nothing
useful to catch.

**Play counts are server-side.** Counted the moment a track starts, once per
load: pausing and resuming, seeking, or leaving it looping on repeat-one all
stay at one play. Skipping through ten tracks therefore does count as ten
plays, which is the deliberate reading — starting a track is the play. They are
what the "Most played" ordering sorts on.

**Ordering and filtering are the same mechanism as playback.** The sort pill,
the favourites pill and the search box all change what  returns, and
 reads that same list. So choosing "Most played" does not just
reorder the screen, it decides what Shuffle draws from and the order playback
follows. There is no second code path for "play this selection".

---

## Local development

```bash
npm run db:schema:local
```

```bash
npx wrangler dev
```

Create a `.dev.vars` file (already git ignored):

```
AUTH_SECRET=anything-local
BOOTSTRAP_KEY=dev
WORKER_TOKEN=dev
```

Then open `http://localhost:8787/auth?k=dev`.

The downloader works locally with no special setup: it is the caller, so
`localhost` is fine:

```bash
APP_URL=http://localhost:8787 WORKER_TOKEN=dev POLL_INTERVAL=5 python downloader/downloader.py
```

In Docker, replace `localhost` with `host.docker.internal`.

### Tests

```bash
node test.mjs
```

64 assertions covering the two things that fail silently when wrong: session
signing (cookie **and** `X-Session` header) and `Range` header parsing.

---

## Costs

| Item | Free allowance | Expected use |
|---|---|---|
| Workers | 100,000 requests/day | ~2,000/day |
| D1 | 5M rows read/day, 100k written, 5 GB | a few thousand |
| R2 | 10 GB, egress always $0 | ~1,500 tracks |
| Downloader | your own machine | ~3 W on a Pi |

**Total: $0.** The only line that can tip into paid is R2 past 10 GB, roughly
1,500 tracks, at $0.015/GB-month after that.

---

## Known iOS bugs to watch

Two regressions independent of this code, worth testing early on your phone:

- **PWA audio on iOS 26.0–26.2**: playback can stop after one track and only
  resume after a reboot. Improved in 26.2, not fixed.
- **[WebKit 261858](https://bugs.webkit.org/show_bug.cgi?id=261858)** (open
  since 2023): automatic advance on `ended` and lock-screen controls can stop
  responding while the app is backgrounded. That is exactly the
  "playlist, screen locked" use case.

The usual mitigation is to preload the next track and keep the Media Session
up to date, which the code already does, but nothing fixes it fully on the
web.

---

## Licence

MIT, see [LICENSE](LICENSE) and the notice at the top of this file.
