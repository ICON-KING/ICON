-- MYTHIC community database. Applied to the connected D1 database.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('자유게시판','질문/답변','모임/모집','사진')),
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_category_created ON posts(category, created_at DESC);

CREATE TABLE IF NOT EXISTS post_images (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  data_url TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_post_images_post ON post_images(post_id, sort_order);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at ASC);

-- Raw IP addresses are not retained. These tables store salted HMAC hashes only.
CREATE TABLE IF NOT EXISTS visitors (
  ip_hash TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS daily_visitors (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (day, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_daily_visitors_day ON daily_visitors(day);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, action)
);

-- Server-side admin configuration and revocable session tokens.
-- Store only a PBKDF2 hash of the administrator password; never store the plaintext password.
CREATE TABLE IF NOT EXISTS admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
