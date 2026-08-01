# Image du téléchargeur — tourne sur ta machine (PC, Raspberry Pi, NAS…).
#
#   docker build -t dmzs-dl ./downloader
#   docker run -d --restart unless-stopped \
#     -e APP_URL=https://music.example.com -e WORKER_TOKEN=... dmzs-dl
#
# Aucun port publié, aucune entrée : le conteneur ne fait que des requêtes
# SORTANTES vers le Worker, qu'il interroge pour savoir s'il y a du travail.
# Rien à ouvrir sur la box, rien à exposer.
#
# C'est aussi ce qui rend le téléchargement fiable : la requête vers YouTube
# part de ton IP résidentielle. Les IP de datacenter — Cloudflare, GCP, Azure —
# sont la cible directe du filtrage anti-bot.

FROM python:3.12-slim

# ffmpeg  : remux (copie de flux, sans réencodage) + recadrage de la vignette
# deno    : OBLIGATOIRE depuis yt-dlp 2025.11.12 — c'est lui qui résout les
#           défis JavaScript de YouTube. Sans runtime JS, yt-dlp perd
#           silencieusement la moitié des formats audio.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path \
    && deno --version

# [default] embarque yt-dlp-ejs, le pont entre yt-dlp et le runtime JS.
RUN pip install --no-cache-dir --upgrade "yt-dlp[default]"

WORKDIR /app
COPY downloader.py .

ENV PYTHONUNBUFFERED=1
CMD ["python", "downloader.py"]
