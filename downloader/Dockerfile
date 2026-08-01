# Downloader image, meant to run on your own machine (PC, Raspberry Pi, NAS).
#
#   docker build -t dmzs-dl ./downloader
#   docker run -d --restart unless-stopped \
#     -e APP_URL=https://music.example.com -e WORKER_TOKEN=... dmzs-dl
#
# No published port and no inbound traffic: the container only makes OUTBOUND
# requests to the Worker, asking whether there is any work. Nothing to open on
# the router, nothing to expose.
#
# It is also what makes downloading reliable: the request to YouTube leaves
# from your residential IP. Datacenter IPs (Cloudflare, GCP, Azure) are the
# direct target of anti-bot filtering.

FROM python:3.12-slim

# ffmpeg : remux (stream copy, no re-encoding) plus thumbnail cropping
# deno   : REQUIRED since yt-dlp 2025.11.12, it is what solves YouTube's
#          JavaScript challenges. Without a JS runtime, yt-dlp silently loses
#          half of the audio formats.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path \
    && deno --version

# [default] pulls in yt-dlp-ejs, the bridge between yt-dlp and the JS runtime.
RUN pip install --no-cache-dir --upgrade "yt-dlp[default]"

WORKDIR /app
COPY downloader.py .

ENV PYTHONUNBUFFERED=1
CMD ["python", "downloader.py"]
