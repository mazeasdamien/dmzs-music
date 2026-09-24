#!/usr/bin/env python3
"""
Downloader, runs on your own machine (PC, Raspberry Pi, NAS).

It PULLS work from the Worker: no port to open, no tunnel, no fixed IP. The
loop polls /internal/next-job, fetches the audio at the highest quality,
remuxes it WITHOUT RE-ENCODING, then sends the file back to the Worker, which
puts it in R2.

That direction of call is what makes the project free (Cloudflare Containers
have no free tier at all) and, more importantly, reliable: the request to
YouTube leaves from a residential IP rather than a datacenter IP filtered by
anti-bot systems.

The remux is just a container swap: the audio bytes are copied as-is. That is
what gives "the best quality available" without the loss an MP3 conversion
would impose.

Environment variables:
  APP_URL        https://music.example.com           (required)
  WORKER_TOKEN   the secret shared with the Worker   (required)
  POLL_INTERVAL  seconds between empty polls         (default 30)
  YT_COOKIES     Netscape cookies, if anti-bot kicks in
  YT_PROXY       http://user:pass@host:port
  JOB_MAX_SECONDS     ceiling on one track               (default 600)
  SUBPROCESS_TIMEOUT  ceiling on one ffmpeg/ffprobe call (default 300)
"""

import base64
import json
import multiprocessing
import os
import re
import subprocess
import tempfile
import time
import traceback
import urllib.request
import urllib.error
from pathlib import Path

APP_URL = os.environ.get("APP_URL", "").rstrip("/")
TOKEN = os.environ.get("WORKER_TOKEN", "")
YT_COOKIES = os.environ.get("YT_COOKIES", "")
YT_PROXY = os.environ.get("YT_PROXY", "")

# 30 s is 2,880 requests/day, painless against the free tier's 100,000/day.
# Dropping to 1 s would burn 86,400 for nothing: the download itself takes
# about thirty seconds, so the wait is invisible.
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "30"))

# How long to stop asking after YouTube blocks the IP. Half an hour is enough
# for a burst-triggered block to lapse; a longer one needs a proxy or cookies,
# and no polling interval will talk you out of it.
BOT_COOLDOWN = float(os.environ.get("BOT_COOLDOWN", "1800"))

# Ceiling on a single drain, which only applies to the served mode. See the
# note in main(): an instance is billed while the request is open.
DRAIN_MAX_SECONDS = float(os.environ.get("DRAIN_MAX_SECONDS", "1800"))

# Ceiling on a single track, in both modes. The drain ceiling above is only
# checked between tracks, so a track that never finishes never reaches it: the
# request stays open, the instance is never idle, and it is billed around the
# clock: $0.21 a day, which is what the bill showed from 19 September. A track
# takes about twenty seconds; ten minutes is far past any real one.
JOB_MAX_SECONDS = float(os.environ.get("JOB_MAX_SECONDS", "600"))

# ffmpeg and ffprobe copy streams (a re-encode at worst), which takes seconds.
# Without a timeout a stuck one would hold the track, and so the drain, forever.
SUBPROCESS_TIMEOUT = float(os.environ.get("SUBPROCESS_TIMEOUT", "300"))

COOKIE_FILE = None
if YT_COOKIES.strip():
    COOKIE_FILE = "/tmp/yt-cookies.txt"
    Path(COOKIE_FILE).write_text(YT_COOKIES)


# -- talking to the Worker -----------------------------------------------
# urllib announces itself as "Python-urllib/3.x" by default, a signature the
# Cloudflare WAF rejects outright: error 1010, a 403 served at the edge before
# the request ever reaches the Worker. Any explicit User-Agent gets through.
USER_AGENT = "dmzs-music-downloader/1.0"


def call_worker(path: str, body: bytes, headers: dict | None = None) -> bool:
    if not APP_URL or not TOKEN:
        print(f"[worker] APP_URL/WORKER_TOKEN missing, skipping {path}")
        return False
    req = urllib.request.Request(
        f"{APP_URL}{path}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "User-Agent": USER_AGENT,
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        print(f"[worker] {path} → HTTP {e.code} {e.read()[:200]!r}")
    except Exception as e:  # noqa: BLE001
        print(f"[worker] {path} → {e}")
    return False


def fetch_job() -> dict | None:
    """
    Claims the next track. Returns None when the queue is empty.
    Raises on network trouble, and the caller then backs off.
    """
    req = urllib.request.Request(
        f"{APP_URL}/internal/next-job",
        method="GET",
        headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read() or b"{}")
    return data if data.get("id") and data.get("url") else None


def report(track_id: str, progress: float, stage: str, **extra) -> None:
    payload = {"id": track_id, "progress": round(progress), "stage": stage,
               "status": "downloading", **extra}
    call_worker("/internal/progress",
                json.dumps(payload).encode(),
                {"Content-Type": "application/json"})


def report_fail(track_id: str, message: str) -> None:
    call_worker("/internal/fail",
                json.dumps({"id": track_id, "error": message}).encode(),
                {"Content-Type": "application/json"})


# -- title cleanup -------------------------------------------------------
# Every bracketed group goes, whatever it holds. Most of them are noise
# ("Official Video", "Lyrics", "4K"), and the rest is not worth the ambiguity
# of deciding case by case. This does drop the occasional "(feat. X)" or
# "(Radio Edit)"; that is the deal.
BRACKETS = re.compile(r"\s*[\(\[\{][^\(\)\[\]\{\}]*[\)\]\}]")

DASHES = re.compile(r"\s+[-–—]\s+")

# Removing brackets does nothing for the noise uploaders hang off the end after
# a pipe or a dash: "| Vevo", "| A COLORS SHOW", "- Official Video". The list is
# deliberately closed rather than a catch-all, because a trailing segment is
# just as often part of the name ("- Extended Mix", "| Sped Up").
TAIL_JUNK = re.compile(
    r"""\s*[|·–—-]\s*(?:
        vevo | ncs | a\s*colors\s*show | colors
      | official\s*(?:music\s*)?(?:video|audio|visuali[sz]er)?
      | lyrics?(?:\s*video)? | visuali[sz]er
      | copyright\s*free\s*music | free\s*(?:music|download)
      | clip\s*officiel | audio\s*officiel | vid[ée]o\s*officielle
      | future\s*house | house\s*music
    )\s*$""",
    re.IGNORECASE | re.VERBOSE,
)


def strip_brackets(text: str) -> str:
    """Removes bracketed groups and trailing uploader noise."""
    prev = None
    while prev != text:
        prev = text
        text = BRACKETS.sub("", text)
    # An unclosed bracket would otherwise survive as a stray opening character.
    text = re.sub(r"\s*[\(\[\{].*$", "", text)
    # Repeated, since these chain: "Feel Good | Future House | NCS".
    prev = None
    while prev != text:
        prev = text
        text = TAIL_JUNK.sub("", text)
    return text.strip(" -–—·|")


def split_title(info: dict) -> tuple[str, str]:
    """Returns (title, artist), preferring YouTube Music metadata."""
    track = (info.get("track") or "").strip()
    artist = (info.get("artist") or info.get("creator") or "").strip()
    if track:
        if not artist:
            artist = (info.get("uploader") or "").strip()
        return strip_brackets(track) or track, re.sub(r"\s*-\s*Topic$", "", artist).strip()

    raw = (info.get("title") or "Untitled").strip()
    clean = strip_brackets(raw)

    parts = DASHES.split(clean, maxsplit=1)
    if len(parts) == 2 and 1 <= len(parts[0]) <= 60:
        return parts[1].strip(), parts[0].strip()

    uploader = re.sub(r"\s*-\s*Topic$", "", (info.get("uploader") or "")).strip()
    return clean or raw, uploader


# -- ffmpeg --------------------------------------------------------------
def run(cmd: list[str]) -> None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=SUBPROCESS_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"{cmd[0]} timed out after {SUBPROCESS_TIMEOUT:.0f} s") from None
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-600:]
        raise RuntimeError(f"{cmd[0]} failed: {tail}")


def probe_codec(path: str) -> str:
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"ffprobe timed out after {SUBPROCESS_TIMEOUT:.0f} s") from None
    return (proc.stdout or "").strip().lower()


def remux(src: str, workdir: str) -> tuple[str, str, str]:
    """
    Picks the container that suits the source codec, never re-encoding when
    it can be avoided. Returns (path, extension, codec).

    Opus has to end up in .ogg: Safari plays Opus ONLY inside an Ogg container
    (since iOS 18.4), never in WebM or MP4.
    """
    codec = probe_codec(src)

    if codec == "opus":
        out = os.path.join(workdir, "audio.ogg")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vn", "-c:a", "copy", out])
        return out, "ogg", "opus"

    if codec in ("aac", "alac"):
        out = os.path.join(workdir, "audio.m4a")
        # faststart moves the index to the front of the file, so playback
        # starts without downloading the whole thing first.
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vn", "-c:a", "copy", "-movflags", "+faststart", out])
        return out, "m4a", codec

    if codec == "mp3":
        out = os.path.join(workdir, "audio.mp3")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vn", "-c:a", "copy", out])
        return out, "mp3", "mp3"

    # Unexpected codec (vorbis, ec-3 and friends): only here do we re-encode,
    # to AAC, to guarantee playback on iPhone.
    out = os.path.join(workdir, "audio.m4a")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
         "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
    return out, "m4a", "aac"


def square_thumbnail(url: str, workdir: str) -> str | None:
    """Downloads the thumbnail and crops it to a centred square."""
    if not url:
        return None
    raw = os.path.join(workdir, "thumb.in")
    out = os.path.join(workdir, "art.jpg")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r, open(raw, "wb") as f:
            f.write(r.read())
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
             "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=640:640",
             "-q:v", "3", out])
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[art] failed: {e}")
        return None


# -- the actual work -----------------------------------------------------
def process(job: dict) -> None:
    import yt_dlp

    track_id = job["id"]
    url = job["url"]
    print(f"[job] {track_id} — start")

    with tempfile.TemporaryDirectory() as workdir:
        last_report = [0.0]
        announced = [False]

        def hook(d):
            if d.get("status") != "downloading":
                return
            now = time.time()
            if now - last_report[0] < 1.2 and announced[0]:
                return
            last_report[0] = now

            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            pct = 8 + (done / total * 74) if total else 40

            # The first call already carries the metadata, so the title shows
            # up on the phone after a second or two, with no second round trip
            # to YouTube.
            extra = {}
            if not announced[0]:
                nfo = d.get("info_dict") or {}
                if nfo:
                    t, a = split_title(nfo)
                    extra = {"title": t, "artist": a,
                             "duration": int(nfo.get("duration") or 0)}
                    announced[0] = True
            report(track_id, pct, "Fetching audio…", **extra)

        opts = {
            # Opus first (~160 kb/s, better than YouTube's 128 kb/s AAC), then
            # m4a, then anything audible.
            "format": "bestaudio[acodec^=opus]/bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": os.path.join(workdir, "src.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [hook],
            "retries": 3,
            "fragment_retries": 3,
            # A connection that stops sending raises instead of waiting. The
            # retries above then have something to retry.
            "socket_timeout": 30,
            # Easing off: hammering the API brings anti-bot filtering on faster.
            "sleep_interval_requests": 1,
        }
        if COOKIE_FILE:
            opts["cookiefile"] = COOKIE_FILE
        if YT_PROXY:
            opts["proxy"] = YT_PROXY

        with yt_dlp.YoutubeDL(opts) as ydl:
            report(track_id, 4, "Analyzing…")
            # A single pass: extraction and download in one go. Two separate
            # calls would double the exposure to anti-bot filtering.
            info = ydl.extract_info(url, download=True)
            src = ydl.prepare_filename(info)

        title, artist = split_title(info)
        duration = int(info.get("duration") or 0)

        if not os.path.exists(src):
            # yt-dlp may have changed the extension along the way.
            candidates = [p for p in Path(workdir).glob("src.*")]
            if not candidates:
                raise RuntimeError("Downloaded file not found")
            src = str(candidates[0])

        report(track_id, 84, "Lossless remux…")
        audio_path, ext, codec = remux(src, workdir)

        abr = info.get("abr") or 0
        try:
            bitrate = int(round(float(abr)))
        except (TypeError, ValueError):
            bitrate = 0

        # Artwork (optional: its failure must not sink the whole track).
        report(track_id, 90, "Artwork…")
        art = None
        for candidate in (
            f"https://i.ytimg.com/vi/{track_id}/maxresdefault.jpg",
            info.get("thumbnail"),
            f"https://i.ytimg.com/vi/{track_id}/hqdefault.jpg",
        ):
            if not candidate:
                continue
            art = square_thumbnail(candidate, workdir)
            if art:
                break
        if art:
            with open(art, "rb") as f:
                call_worker(f"/internal/art?id={track_id}", f.read(),
                            {"Content-Type": "image/jpeg"})

        report(track_id, 94, "Uploading to R2…")
        meta = {
            "title": title,
            "artist": artist,
            "duration": duration,
            "codec": codec,
            "ext": ext,
            "bitrate": bitrate,
        }
        with open(audio_path, "rb") as f:
            payload = f.read()

        # ensure_ascii=True (the default) turns accents into \uXXXX, so the
        # base64 stays pure ASCII and survives the HTTP header intact.
        header = base64.b64encode(json.dumps(meta).encode("ascii")).decode("ascii")
        ok = call_worker(
            f"/internal/complete?id={track_id}",
            payload,
            {"Content-Type": "application/octet-stream", "X-Meta": header},
        )
        if not ok:
            raise RuntimeError("The Worker rejected the final file")

    print(f"[job] {track_id} — done ({len(payload)} bytes, {ext})")


def handle(job: dict) -> bool:
    """
    Handles one job. A failure is reported to the Worker, never fatal to the
    loop. Returns True when the failure was anti-bot filtering, which the
    caller treats differently from an ordinary one.
    """
    try:
        process(job)
        return False
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        msg = str(e)
        low = msg.lower()
        blocked = "sign in to confirm" in low or "bot" in low or "429" in low
        if blocked:
            msg = ("YouTube blocked the request: anti-bot filtering on this IP. "
                   "Waiting before trying again. See the README, "
                   "section \"If YouTube blocks you\".")
        elif "unavailable" in low or "private" in low:
            msg = "Video unavailable or private."
        report_fail(job["id"], msg[:400])
        return blocked


# -- one track, with a deadline ------------------------------------------
BLOCKED_EXIT = 3


def _job_child(job: dict) -> None:
    raise SystemExit(BLOCKED_EXIT if handle(job) else 0)


def run_with_deadline(target, args: tuple, seconds: float) -> int | None:
    """
    Runs target(*args) in a child process. Returns its exit code, or None when
    it was still running after `seconds` and had to be stopped.

    A child process rather than a thread, because a thread cannot be stopped:
    yt-dlp runs in-process, and when it hangs only killing the process ends it.
    "spawn" rather than fork, because server.py calls this from a threaded
    HTTP server, and forking a threaded process can deadlock the child.
    """
    child = multiprocessing.get_context("spawn").Process(
        target=target, args=args, daemon=True)
    child.start()
    child.join(seconds)
    if not child.is_alive():
        return child.exitcode
    child.terminate()
    child.join(10)
    if child.is_alive():
        child.kill()
        child.join()
    return None


def handle_with_deadline(job: dict) -> bool:
    """
    handle(), stopped past JOB_MAX_SECONDS. Same return value: True when the
    failure was anti-bot filtering.

    A stopped track is reported as failed. Left alone, it would sit in
    'downloading' until the Worker's lease handed it back as pending, and the
    cron's backstop would wake the container for it every twenty minutes,
    which is the loop this exists to break.
    """
    code = run_with_deadline(_job_child, (job,), JOB_MAX_SECONDS)
    if code is None:
        print(f"[job] {job['id']} — over {JOB_MAX_SECONDS:.0f} s, stopped")
        report_fail(job["id"], f"Stopped after {JOB_MAX_SECONDS / 60:.0f} "
                               "minutes without finishing. Add it again to retry.")
        return False
    if code == BLOCKED_EXIT:
        return True
    if code != 0:
        # handle() reports its own failures, so a non-zero exit means the child
        # died before it could: killed for memory, or the interpreter itself.
        report_fail(job["id"], f"The downloader stopped unexpectedly (exit {code}).")
    return False


# -- polling loop --------------------------------------------------------
def main(drain_once: bool = False) -> None:
    """
    Polls for work until stopped.

    With `drain_once`, an empty queue returns instead of waiting. That is the
    Cloudflare Containers shape: the instance is woken by the Worker, takes
    everything that is queued, and returns so it can be put back to sleep.
    Polling an empty queue there would be paid-for idling, which is the one
    thing an on-demand instance exists to avoid.
    """
    if not APP_URL or not TOKEN:
        raise SystemExit(
            "APP_URL and WORKER_TOKEN are required.\n"
            "  Windows, no Docker  : npm run dl\n"
            "  Docker              : docker run -e APP_URL=... -e WORKER_TOKEN=... dmzs-dl"
        )

    print(f"[boot] polling {APP_URL} every {POLL_INTERVAL:.0f} s")
    errors = 0
    idle = False
    started = time.monotonic()

    while True:
        # A drain is billed until it returns, so no path through this loop may
        # run unbounded. Guarding each exit is the fix; this is the floor under
        # it, so the next one anybody forgets costs half an hour rather than a
        # month. Well past a real queue: tracks take about twenty seconds.
        if drain_once and time.monotonic() - started > DRAIN_MAX_SECONDS:
            print("[poll] drain budget spent, handing back")
            return
        try:
            job = fetch_job()
            errors = 0
        except Exception as e:  # noqa: BLE001
            errors += 1
            if drain_once:
                # Every second spent here is billed, because the request that
                # started the drain is still open and an instance with an open
                # request is never idle. Waiting also buys nothing: a Worker
                # that cannot be reached now will be reached by the next
                # wake-up, on a fresh instance, or not at all. This was the one
                # exit that did not hand back, and it cost about seven dollars
                # a month in an instance that never slept.
                print(f"[poll] unreachable ({e}), handing back")
                return
            # Worker unreachable (network cut, deploy in progress): back off
            # instead of hammering, up to 5 minutes between attempts.
            delay = min(POLL_INTERVAL * 2 ** min(errors, 4), 300)
            print(f"[poll] unreachable ({e}) — retrying in {delay:.0f} s")
            time.sleep(delay)
            continue

        if job:
            idle = False
            print(f"[poll] job received: {job['id']}")
            blocked = handle_with_deadline(job)

            if blocked:
                # Without this the loop went straight back for the next job and
                # failed it the same way, so one block turned into a queue-wide
                # wipeout in under a minute. Anti-bot filtering is applied to
                # the IP, not the request: the only useful response is to stop
                # asking for a while.
                if drain_once:
                    # Sleeping it off would be billed by the second, and the
                    # instance is woken on demand anyway. Hand back instead and
                    # let the next track's wake-up be the retry.
                    print("[poll] anti-bot filtering, handing back")
                    return
                print(f"[poll] anti-bot filtering, pausing {BOT_COOLDOWN / 60:.0f} min")
                time.sleep(BOT_COOLDOWN)
                continue

            # Straight back round: a queue of several tracks drains back to
            # back, without waiting an interval between each.
            continue

        if drain_once:
            print("[poll] queue empty, done")
            return
        if not idle:
            # One line when going idle, rather than a log every 30 s.
            print("[poll] queue empty, waiting")
            idle = True
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[boot] stopped")
