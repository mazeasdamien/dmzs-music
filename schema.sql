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
