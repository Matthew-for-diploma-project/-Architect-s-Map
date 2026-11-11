-- Bytes and metadata are one atomic row; size cannot disagree with stored bytes.
CREATE TABLE images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text COLLATE pg_catalog."pg_c_utf8" NOT NULL,
  mime_type text COLLATE "C" NOT NULL,
  file_data bytea NOT NULL,
  size_bytes integer GENERATED ALWAYS AS (octet_length(file_data)) STORED NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  south double precision NOT NULL,
  west double precision NOT NULL,
  north double precision NOT NULL,
  east double precision NOT NULL,
  angle smallint NOT NULL DEFAULT 0,
  opacity double precision NOT NULL DEFAULT 0.65,
  locked boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT images_name_valid CHECK (
    char_length(name) BETWEEN 1 AND 255 AND btrim(name) <> ''
    AND name NOT IN ('.', '..') AND strpos(name, '/') = 0
    AND strpos(name, chr(92)) = 0 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT images_mime_valid CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT images_size_valid CHECK (size_bytes BETWEEN 1 AND 20971520),
  CONSTRAINT images_dimensions_valid CHECK (
    width BETWEEN 1 AND 16384 AND height BETWEEN 1 AND 16384
    AND width::bigint * height::bigint <= 40000000
  ),
  CONSTRAINT images_bounds_valid CHECK (
    south >= -85 AND south < north AND north <= 85
    AND west >= -180 AND west < east AND east <= 180
  ),
  CONSTRAINT images_angle_valid CHECK (angle BETWEEN -180 AND 180),
  CONSTRAINT images_opacity_valid CHECK (opacity BETWEEN 0 AND 1),
  CONSTRAINT images_revision_valid CHECK (revision > 0),
  CONSTRAINT images_dates_valid CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at)
);

CREATE INDEX images_user_created_id_idx ON images (user_id, created_at, id);

CREATE TABLE layer_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  opacity double precision NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT layer_settings_opacity_valid CHECK (opacity BETWEEN 0 AND 1),
  CONSTRAINT layer_settings_revision_valid CHECK (revision > 0),
  CONSTRAINT layer_settings_dates_valid CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at)
);

-- Preserve existing P04 accounts, even if they have no images yet.
INSERT INTO layer_settings (user_id) SELECT id FROM users;

-- List queries use this explicit projection, never SELECT * FROM images.
-- The stored size is available without reading file_data in the list query.
CREATE VIEW image_metadata WITH (security_invoker = true) AS
SELECT id, user_id, name, mime_type, size_bytes, width, height,
       south, west, north, east, angle, opacity, locked, revision,
       created_at, updated_at
FROM images;
