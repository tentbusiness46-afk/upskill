-- ============================================================
-- UPSKILL10X — SQLite / Turso schema
-- Columns added after the first release (course_id, all_access,
-- is_preview, item_type, percent_off …) are NOT listed here: they
-- are added by db/init.js as safe, idempotent migrations so the same
-- script works on a fresh database and on the existing production one.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'student',   -- 'student' | 'admin'
  is_enrolled   INTEGER NOT NULL DEFAULT 0,         -- 1 once the user has bought anything
  enrolled_at   TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Legacy: applications from the old selection-round (PWYS) form.
-- The form is gone; the table is kept so old records aren't lost.
CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  whatsapp        TEXT,
  email           TEXT NOT NULL,
  status_field    TEXT,
  city            TEXT,
  obstacle        TEXT,
  hours_and_goal  TEXT,
  commitment      TEXT,
  has_laptop      TEXT,
  coupon_sent     TEXT,
  coupon_sent_at  TEXT,
  submitted_at    TEXT NOT NULL
);

-- Reusable discount coupons. New coupons use percent_off (added by
-- migration) and work on any course or the bundle. Old coupons that only
-- have discount_price keep working as a fixed final price for the bundle.
CREATE TABLE IF NOT EXISTS coupons (
  code           TEXT PRIMARY KEY,
  discount_price INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
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

-- A course is what students browse and buy. Modules belong to a course
-- (modules.course_id), videos belong to a module.
CREATE TABLE IF NOT EXISTS courses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,     -- used in URLs: /course/<slug>
  title          TEXT NOT NULL,
  subtitle       TEXT,
  description    TEXT,
  category       TEXT,
  level          TEXT DEFAULT 'Beginner',
  language       TEXT DEFAULT 'Hindi + English',
  outcomes       TEXT,                     -- "What you'll learn", one point per line
  price          INTEGER NOT NULL DEFAULT 499,   -- rupees
  mrp            INTEGER,                        -- rupees, shown struck through
  thumbnail_url  TEXT,
  theme          INTEGER NOT NULL DEFAULT 0,     -- colour preset for the generated thumbnail
  order_index    INTEGER NOT NULL DEFAULT 0,
  published      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per individually-bought course. The bundle is stored on the
-- user instead (users.all_access = 1) so it covers future courses too.
CREATE TABLE IF NOT EXISTS enrollments (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  order_id   INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, course_id)
);

-- Small key/value store for admin-editable values (bundle price etc.).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
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
  hls_url        TEXT,
  thumbnail_url  TEXT,
  encryption_key_b64 TEXT,
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

CREATE TABLE IF NOT EXISTS curriculum_downloads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_curriculum_downloads_email ON curriculum_downloads(email);
CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON thread_posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);
CREATE INDEX IF NOT EXISTS idx_enrollments_user ON enrollments(user_id);
