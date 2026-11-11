-- PostgreSQL 17 / UTF8. The runner owns the transaction and migration history.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text COLLATE "C" NOT NULL,
  name text NOT NULL,
  -- Self-describing hash (including salt/parameters); its format is defined in P07.
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_email_normalized CHECK (
    email = lower(btrim(email) COLLATE pg_catalog."pg_c_utf8")
    AND char_length(email) BETWEEN 3 AND 254
  ),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 80
    AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT users_password_hash_valid CHECK (char_length(password_hash) BETWEEN 1 AND 2048)
);

-- Enforce canonical storage before the unique constraint, including direct SQL writes.
-- pg_c_utf8 supplies Unicode simple lowercase independently of the OS locale.
CREATE FUNCTION normalize_user_email() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email) COLLATE pg_catalog."pg_c_utf8");
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_normalize_email
BEFORE INSERT OR UPDATE OF email ON users
FOR EACH ROW EXECUTE FUNCTION normalize_user_email();

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_valid CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
