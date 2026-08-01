#!/usr/bin/env python3
"""
Téléchargeur — tourne sur ta machine (PC, Raspberry Pi, NAS…).

Il vient CHERCHER le travail auprès du Worker : aucun port à ouvrir, aucun
tunnel, aucune IP fixe. La boucle interroge /internal/next-job, récupère
l'audio en qualité maximale, le remuxe SANS RÉENCODAGE, puis renvoie le
fichier au Worker qui le dépose dans R2.

C'est ce sens d'appel qui rend le projet gratuit — les Containers Cloudflare
n'ont aucun palier gratuit — et surtout fiable : la requête vers YouTube part
d'une IP résidentielle, pas d'une IP de datacenter filtrée par l'anti-bot.

Le remux est une simple bascule de conteneur : les octets audio sont copiés
tels quels. C'est ce qui permet d'avoir « la meilleure qualité possible »
sans la perte qu'imposerait une conversion en MP3.

Variables d'environnement :
  APP_URL        https://music.example.com          (obligatoire)
  WORKER_TOKEN   le secret partagé avec le Worker    (obligatoire)
  POLL_INTERVAL  secondes entre deux sondages à vide (défaut 30)
  YT_COOKIES     cookies Netscape, si l'anti-bot se déclenche
  YT_PROXY       http://user:pass@hote:port
"""

import base64
import json
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

# 30 s = 2 880 requêtes/jour, indolore sur les 100 000/jour du palier gratuit.
# Descendre à 1 s en consommerait 86 400 pour rien : le téléchargement lui-même
# dure une trentaine de secondes, l'attente ne se voit pas.
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "30"))

COOKIE_FILE = None
if YT_COOKIES.strip():
    COOKIE_FILE = "/tmp/yt-cookies.txt"
    Path(COOKIE_FILE).write_text(YT_COOKIES)


# ── communication avec le Worker ────────────────────────────────────────
# urllib s'annonce par défaut en « Python-urllib/3.x », une signature que le
# WAF de Cloudflare rejette d'office : erreur 1010, un 403 rendu au bord avant
# même d'atteindre le Worker. N'importe quel User-Agent explicite passe.
USER_AGENT = "dmzs-music-downloader/1.0"


def call_worker(path: str, body: bytes, headers: dict | None = None) -> bool:
    if not APP_URL or not TOKEN:
        print(f"[worker] APP_URL/WORKER_TOKEN absents, appel {path} ignoré")
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
    Réclame le prochain titre. Renvoie None si la file est vide.
    Lève en cas de problème réseau : l'appelant applique alors un recul.
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


# ── nettoyage des titres ────────────────────────────────────────────────
JUNK = re.compile(
    r"""\s*[\(\[]\s*(?:
        official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer)?
      | lyrics?(?:\s*video)? | audio | video | visuali[sz]er | hd | hq | 4k
      | remaster(?:ed)?(?:\s*\d{4})? | full\s*album | mv | m/v
      | clip\s*officiel | audio\s*officiel | vid[ée]o\s*officielle
    )\s*[\)\]]""",
    re.IGNORECASE | re.VERBOSE,
)

DASHES = re.compile(r"\s+[-–—]\s+")


def split_title(info: dict) -> tuple[str, str]:
    """Renvoie (titre, artiste) en privilégiant les métadonnées YouTube Music."""
    track = (info.get("track") or "").strip()
    artist = (info.get("artist") or info.get("creator") or "").strip()
    if track:
        if not artist:
            artist = (info.get("uploader") or "").strip()
        return track, re.sub(r"\s*-\s*Topic$", "", artist).strip()

    raw = (info.get("title") or "Untitled").strip()
    clean = JUNK.sub("", raw).strip(" -–—·|")

    parts = DASHES.split(clean, maxsplit=1)
    if len(parts) == 2 and 1 <= len(parts[0]) <= 60:
        return parts[1].strip(), parts[0].strip()

    uploader = re.sub(r"\s*-\s*Topic$", "", (info.get("uploader") or "")).strip()
    return clean or raw, uploader


# ── ffmpeg ──────────────────────────────────────────────────────────────
def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-600:]
        raise RuntimeError(f"{cmd[0]} failed: {tail}")


def probe_codec(path: str) -> str:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    return (proc.stdout or "").strip().lower()


def remux(src: str, workdir: str) -> tuple[str, str, str]:
    """
    Choisit le conteneur adapté au codec source, sans jamais réencoder
    quand c'est évitable. Renvoie (chemin, extension, codec).

    Opus doit finir en .ogg : Safari ne lit Opus QUE dans un conteneur Ogg
    (depuis iOS 18.4), jamais dans du WebM ni du MP4.
    """
    codec = probe_codec(src)

    if codec == "opus":
        out = os.path.join(workdir, "audio.ogg")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vn", "-c:a", "copy", out])
        return out, "ogg", "opus"

    if codec in ("aac", "alac"):
        out = os.path.join(workdir, "audio.m4a")
        # faststart déplace l'index en tête du fichier : la lecture démarre
        # sans avoir à télécharger le fichier entier.
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vn", "-c:a", "copy", "-movflags", "+faststart", out])
        return out, "m4a", codec

    if codec == "mp3":
        out = os.path.join(workdir, "audio.mp3")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vn", "-c:a", "copy", out])
        return out, "mp3", "mp3"

    # Codec inattendu (vorbis, ec-3…) : là seulement on réencode, en AAC,
    # pour garantir la lecture sur iPhone.
    out = os.path.join(workdir, "audio.m4a")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
         "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
    return out, "m4a", "aac"


def square_thumbnail(url: str, workdir: str) -> str | None:
    """Télécharge la vignette et la recadre en carré centré."""
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
        print(f"[art] échec : {e}")
        return None


# ── cœur du travail ─────────────────────────────────────────────────────
def process(job: dict) -> None:
    import yt_dlp

    track_id = job["id"]
    url = job["url"]
    print(f"[job] {track_id} — début")

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

            # Le premier appel porte déjà les métadonnées : le titre s'affiche
            # sur le téléphone au bout d'une seconde ou deux, sans avoir eu à
            # interroger YouTube une deuxième fois.
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
            # Opus en priorité (~160 kb/s, meilleur que l'AAC 128 de YouTube),
            # puis m4a, puis n'importe quoi d'audible.
            "format": "bestaudio[acodec^=opus]/bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": os.path.join(workdir, "src.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [hook],
            "retries": 3,
            "fragment_retries": 3,
            # On lève le pied : marteler l'API accélère le filtrage anti-bot.
            "sleep_interval_requests": 1,
        }
        if COOKIE_FILE:
            opts["cookiefile"] = COOKIE_FILE
        if YT_PROXY:
            opts["proxy"] = YT_PROXY

        with yt_dlp.YoutubeDL(opts) as ydl:
            report(track_id, 4, "Analyzing…")
            # Un seul passage : extraction et téléchargement d'un coup.
            # Deux appels séparés doubleraient l'exposition au filtrage anti-bot.
            info = ydl.extract_info(url, download=True)
            src = ydl.prepare_filename(info)

        title, artist = split_title(info)
        duration = int(info.get("duration") or 0)

        if not os.path.exists(src):
            # yt-dlp a pu changer l'extension en cours de route.
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

        # Vignette (facultative : son échec ne doit pas faire rater le titre).
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

        # ensure_ascii=True (défaut) : les accents sortent en \uXXXX, donc le
        # base64 reste pur ASCII et traverse l'en-tête HTTP sans dommage.
        header = base64.b64encode(json.dumps(meta).encode("ascii")).decode("ascii")
        ok = call_worker(
            f"/internal/complete?id={track_id}",
            payload,
            {"Content-Type": "application/octet-stream", "X-Meta": header},
        )
        if not ok:
            raise RuntimeError("The Worker rejected the final file")

    print(f"[job] {track_id} — terminé ({len(payload)} octets, {ext})")


def handle(job: dict) -> None:
    """Traite un job. Un échec est signalé au Worker, jamais fatal pour la boucle."""
    try:
        process(job)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        msg = str(e)
        low = msg.lower()
        if "sign in to confirm" in low or "bot" in low:
            msg = ("YouTube blocked the request (anti-bot filtering on this IP). "
                   "See the README, section \u00ab Si YouTube bloque \u00bb.")
        elif "unavailable" in low or "private" in low:
            msg = "Video unavailable or private."
        report_fail(job["id"], msg[:400])


# ── boucle de sondage ───────────────────────────────────────────────────
def main() -> None:
    if not APP_URL or not TOKEN:
        raise SystemExit(
            "APP_URL et WORKER_TOKEN sont obligatoires.\n"
            "  Windows, sans Docker : npm run dl\n"
            "  Docker               : docker run -e APP_URL=... -e WORKER_TOKEN=... dmzs-dl"
        )

    print(f"[boot] sondage de {APP_URL} toutes les {POLL_INTERVAL:.0f} s")
    errors = 0
    idle = False

    while True:
        try:
            job = fetch_job()
            errors = 0
        except Exception as e:  # noqa: BLE001
            errors += 1
            # Worker injoignable (coupure réseau, déploiement en cours) : on
            # recule au lieu de marteler, jusqu'à 5 minutes entre deux essais.
            delay = min(POLL_INTERVAL * 2 ** min(errors, 4), 300)
            print(f"[poll] injoignable ({e}) — nouvel essai dans {delay:.0f} s")
            time.sleep(delay)
            continue

        if job:
            idle = False
            print(f"[poll] job reçu : {job['id']}")
            handle(job)
            # On repart aussitôt : une file de plusieurs titres se vide d'affilée
            # sans attendre un intervalle entre chaque.
            continue

        if not idle:
            # Une seule ligne au passage à vide : pas de log toutes les 30 s.
            print("[poll] file vide, en attente")
            idle = True
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[boot] arrêt")
