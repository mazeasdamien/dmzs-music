# Downloader image. One image, two ways of running it.
#
#   MODE unset (default)  polls the Worker forever. This is the shape for your
#                         own machine — PC, Raspberry Pi, NAS:
#
#     docker build -t dmzs-dl ./downloader
#     docker run -d --restart unless-stopped \
#       -e APP_URL=https://music.example.com -e WORKER_TOKEN=... dmzs-dl
#
#   MODE=serve            listens on $PORT and drains the queue when asked.
#                         This is the shape Cloudflare Containers needs, and
#                         what `npx wrangler deploy` builds; nothing to run by
#                         hand.
#
# In neither case is there inbound traffic from the internet. Polling makes
# only outbound requests, so there is nothing to open on a router; the served
# mode is reachable from your own Worker and from nothing else.
#
# Worth knowing before you choose. Polling from home leaves for YouTube from a
# residential address. A container leaves from Cloudflare's egress range, which
# is a datacenter range, and datacenter ranges are what anti-bot filtering
# watches for. Set YT_COOKIES, and YT_PROXY if it comes to that; see the README
# section "If YouTube blocks you".

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
# Pinned to nothing on purpose: YouTube breaks extractors every few months, and
# a rebuild is how this image picks the fix up.
RUN pip install --no-cache-dir --upgrade "yt-dlp[default]"

WORKDIR /app
COPY downloader.py server.py ./

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["sh", "-c", "if [ \"$MODE\" = serve ]; then exec python server.py; else exec python downloader.py; fi"]
