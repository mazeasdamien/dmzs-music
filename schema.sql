-- dmzs-music, D1 schema
-- The id is the YouTube video id: unique by nature, which makes
-- deduplication free.

CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,              -- YouTube video id (11 chars)
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,    -- seconds
  size        INTEGER NOT NULL DEFAULT 0,    -- audio file size in bytes
  codec       TEXT    NOT NULL DEFAULT '',   -- opus | aac
  ext         TEXT    NOT NULL DEFAULT '',   -- ogg  | m4a
  bitrate     INTEGER NOT NULL DEFAULT 0,    -- kb/s
  status      TEXT    NOT NULL DEFAULT 'pending',
                                             -- pending | downloading | ready | error
  progress    INTEGER NOT NULL DEFAULT 0,    -- 0-100
  stage       TEXT    NOT NULL DEFAULT '',   -- label shown while working
  error       TEXT,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER,                       -- ms; downloader lease, NULL when free
  plays       INTEGER NOT NULL DEFAULT 0,    -- play count, across all devices
  fav         INTEGER NOT NULL DEFAULT 0     -- 1 when starred, shared across devices
);

CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_status  ON tracks(status);

-- Playlists. A hand-made selection, in an order somebody chose — which is the
-- one thing the library's own views cannot express: Recent, Most played and
-- Mixes all derive their order from the tracks themselves.
--
-- Membership is a plain join table rather than a JSON column so that deleting
-- a track cannot leave a dangling id behind (ON DELETE CASCADE does it).

CREATE TABLE IF NOT EXISTS playlists (
  id         TEXT PRIMARY KEY,               -- 12 hex chars, hash of the name
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
  -- Sparse on purpose: appending is MAX(position)+1 and never renumbers the
  -- rows already there, so adding a track is one INSERT.
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_pltracks ON playlist_tracks(playlist_id, position);

-- Podcasts. Unlike tracks, episodes are fetched by the Worker itself (an
-- enclosure is a plain audio URL, nothing to circumvent), so the downloader
-- machine is not involved at all.

CREATE TABLE IF NOT EXISTS podcasts (
  id           TEXT PRIMARY KEY,              -- 12 hex chars, hash of feed_url
  feed_url     TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',      -- source of podart/<id>.jpg in R2
  description  TEXT NOT NULL DEFAULT '',
  keep         INTEGER NOT NULL DEFAULT 5,    -- episodes kept in R2 per show
  created_at   INTEGER NOT NULL,
  last_checked INTEGER,                       -- ms; hourly refresh bookkeeping
  last_error   TEXT                           -- last refresh failure, if any
);

CREATE TABLE IF NOT EXISTS episodes (
  id           TEXT PRIMARY KEY,              -- 16 hex chars, hash of podcast+guid
  podcast_id   TEXT NOT NULL,
  guid         TEXT NOT NULL,                 -- feed's own id, dedup key
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  audio_url    TEXT NOT NULL,
  duration     INTEGER NOT NULL DEFAULT 0,    -- seconds
  size         INTEGER NOT NULL DEFAULT 0,    -- bytes actually stored in R2
  ext          TEXT    NOT NULL DEFAULT '',   -- mp3 | m4a | ogg
  published_at INTEGER NOT NULL DEFAULT 0,    -- ms
  status       TEXT    NOT NULL DEFAULT 'new',
                                              -- new | queued | fetching | ready | error
  error        TEXT,
  position     INTEGER NOT NULL DEFAULT 0,    -- resume point in seconds, cross-device
  played       INTEGER NOT NULL DEFAULT 0,    -- 1 once listened to the end
  fetched_at   INTEGER,                       -- ms; retention evicts oldest-fetched
  claimed_at   INTEGER,                       -- ms; fetch lease, NULL when free
  created_at   INTEGER NOT NULL,
  UNIQUE (podcast_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_episodes_pod    ON episodes(podcast_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
