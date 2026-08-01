-- dmzs-music — schéma D1
-- L'id est l'identifiant de la vidéo YouTube : unique par nature,
-- ce qui rend la déduplication gratuite.

CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,              -- id vidéo YouTube (11 car.)
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,    -- secondes
  size        INTEGER NOT NULL DEFAULT 0,    -- octets du fichier audio
  codec       TEXT    NOT NULL DEFAULT '',   -- opus | aac
  ext         TEXT    NOT NULL DEFAULT '',   -- ogg  | m4a
  bitrate     INTEGER NOT NULL DEFAULT 0,    -- kb/s
  status      TEXT    NOT NULL DEFAULT 'pending',
                                             -- pending | downloading | ready | error
  progress    INTEGER NOT NULL DEFAULT 0,    -- 0-100
  stage       TEXT    NOT NULL DEFAULT '',   -- libellé affiché pendant le travail
  error       TEXT,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER,                       -- ms ; bail du téléchargeur, NULL si libre
  plays       INTEGER NOT NULL DEFAULT 0     -- nombre d'écoutes, tous appareils
);

CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_status  ON tracks(status);
