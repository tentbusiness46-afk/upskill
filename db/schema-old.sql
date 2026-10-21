-- ============================================================
-- ELEVATE EDGE — SQLite schema
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'student',   -- 'student' | 'admin'
  is_enrolled   INTEGER NOT NULL DEFAULT 0,         -- 1 once payment verified
  enrolled_at   TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Applications submitted from pwys.html ("selection round" form)
CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  whatsapp        TEXT,
  email           TEXT NOT NULL,
  status_field    TEXT,     -- the applicant's employment/study status (from form's "status" radio)
  city            TEXT,
  obstacle        TEXT,
  hours_and_goal  TEXT,
  commitment      TEXT,
  has_laptop      TEXT,
  review_status   TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  coupon_code     TEXT,      -- set once admin issues a coupon for this applicant
  coupon_emailed  INTEGER NOT NULL DEFAULT 0,
  submitted_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  code           TEXT PRIMARY KEY,
  applicant_email TEXT,
  application_id  INTEGER REFERENCES applications(id),
  discount_price  INTEGER NOT NULL,      -- e.g. 999
  is_used         INTEGER NOT NULL DEFAULT 0,
  used_by_user_id INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  user_id           INTEGER REFERENCES users(id),
  name              TEXT,
  email             TEXT,
  phone             TEXT,
  amount            INTEGER NOT NULL,   -- in paise
  currency          TEXT NOT NULL DEFAULT 'INR',
  coupon_code       TEXT,
  status            TEXT NOT NULL DEFAULT 'created', -- created | paid | failed
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id            INTEGER NOT NULL REFERENCES orders(id),
  razorpay_payment_id TEXT NOT NULL,
  razorpay_signature  TEXT NOT NULL,
  verified_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id      INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  order_index    INTEGER NOT NULL DEFAULT 0,
  duration_secs  INTEGER DEFAULT 0,
  hls_url        TEXT,        -- https://videos.<yourdomain>/<path>/master.m3u8  (R2 public/custom domain)
  thumbnail_url  TEXT,
  encryption_key_b64 TEXT,    -- base64 of the 16-byte AES-128 key used to encrypt this video's .ts segments
                               -- served only to authenticated, unlocked users via /api/lms/videos/:id/key
  published      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  video_id     INTEGER NOT NULL REFERENCES videos(id),
  completed    INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_videos_module ON videos(module_id);
CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON thread_posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);
