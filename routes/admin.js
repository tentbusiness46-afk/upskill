// routes/admin.js
// All routes here require an authenticated admin (see server.js mount).
const express = require('express');
const db = require('../db');
const catalog = require('../utils/catalog');

const router = express.Router();

/* ============================================================
   APPLICATIONS (from the selection round / pwys.html)
============================================================ */
router.get('/applications', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM applications ORDER BY submitted_at DESC').all();
  res.json({ applications: rows });
});

// Record which coupon code your team emailed this applicant. Re-selectable
// any number of times (e.g. if you sent the wrong code, or the coupon it
// pointed to was later renamed/deleted) — this is a note for your records,
// it does not gate anything on the backend.
router.post('/applications/:id/mark-emailed', async (req, res) => {
  const { coupon_code } = req.body || {};
  const cleanCode = (coupon_code || '').trim();
  if (!cleanCode) return res.status(400).json({ error: 'Select a coupon code before marking as emailed.' });

  const app = await db.prepare('SELECT id FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  const coupon = await db.prepare('SELECT code FROM coupons WHERE code = ?').get(cleanCode);
  if (!coupon) return res.status(400).json({ error: 'That coupon code no longer exists.' });

  await db.prepare(`UPDATE applications SET coupon_sent = ?, coupon_sent_at = datetime('now') WHERE id = ?`)
    .run(coupon.code, req.params.id);
  res.json({ ok: true });
});

/* ============================================================
   COUPONS — reusable discount codes you create by hand.
   No expiry, no use cap; stays active until you edit/delete it.
============================================================ */
router.get('/coupons', async (req, res) => {
  const rows = await db.prepare(
    `SELECT c.code, c.discount_price, c.percent_off, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM orders o WHERE o.coupon_code = c.code AND o.status = 'paid') AS used_count,
            (SELECT COUNT(*) FROM applications a WHERE a.coupon_sent = c.code) AS sent_count
     FROM coupons c ORDER BY c.created_at DESC`
  ).all();
  res.json({ coupons: rows });
});

router.post('/coupons', async (req, res) => {
  const { code, percent_off } = req.body || {};
  const cleanCode = (code || '').trim();
  const pct = Number(percent_off);
  if (!cleanCode) return res.status(400).json({ error: 'Coupon code is required.' });
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return res.status(400).json({ error: 'Enter a discount between 1 and 100%.' });

  const existing = await db.prepare('SELECT code FROM coupons WHERE code = ? COLLATE NOCASE').get(cleanCode);
  if (existing) return res.status(409).json({ error: 'A coupon with this code already exists.' });

  await db.prepare('INSERT INTO coupons (code, discount_price, percent_off) VALUES (?, 0, ?)').run(cleanCode, Math.round(pct));
  res.json({ ok: true });
});

// Both the code text and the price are editable. Renaming a code carries
// its "sent to" history forward (application records that referenced the
// old code text are repointed to the new one).
router.put('/coupons/:code', async (req, res) => {
  const { code, percent_off } = req.body || {};
  const existing = await db.prepare('SELECT * FROM coupons WHERE code = ?').get(req.params.code);
  if (!existing) return res.status(404).json({ error: 'Coupon not found.' });

  const newCode = (code !== undefined ? code : existing.code).trim();
  const pct = percent_off !== undefined ? Number(percent_off) : existing.percent_off;
  if (!newCode) return res.status(400).json({ error: 'Coupon code is required.' });
  if (!Number.isFinite(Number(pct)) || pct <= 0 || pct > 100) return res.status(400).json({ error: 'Enter a discount between 1 and 100%.' });

  if (newCode !== existing.code) {
    const clash = await db.prepare('SELECT code FROM coupons WHERE code = ? COLLATE NOCASE').get(newCode);
    if (clash) return res.status(409).json({ error: 'A coupon with this code already exists.' });
    await db.transaction([
      { sql: 'INSERT INTO coupons (code, discount_price, percent_off, created_at) VALUES (?, ?, ?, ?)', args: [newCode, existing.discount_price || 0, Math.round(pct), existing.created_at] },
      { sql: 'UPDATE applications SET coupon_sent = ? WHERE coupon_sent = ?', args: [newCode, existing.code] },
      { sql: 'DELETE FROM coupons WHERE code = ?', args: [existing.code] }
    ]);
  } else {
    await db.prepare(`UPDATE coupons SET percent_off = ?, updated_at = datetime('now') WHERE code = ?`)
      .run(Math.round(pct), existing.code);
  }
  res.json({ ok: true });
});

router.delete('/coupons/:code', async (req, res) => {
  const info = await db.prepare('DELETE FROM coupons WHERE code = ?').run(req.params.code);
  if (info.changes === 0) return res.status(404).json({ error: 'Coupon not found.' });
  res.json({ ok: true });
});

/* ============================================================
   CURRICULUM DOWNLOAD LEADS (from index.html's "Download Curriculum" modal)
============================================================ */
router.get('/curriculum-downloads', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM curriculum_downloads ORDER BY downloaded_at DESC').all();
  res.json({ downloads: rows });
});

/* ============================================================
   USERS / ENROLLMENTS / ACTIVE USERS
============================================================ */
router.get('/users', async (req, res) => {
  const rows = await db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.is_enrolled, u.all_access, u.enrolled_at, u.last_login_at, u.created_at,
            (SELECT GROUP_CONCAT(c.title, ' · ') FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = u.id) AS courses
     FROM users u ORDER BY u.created_at DESC`
  ).all();
  res.json({ users: rows });
});

// "Currently active" = logged in within the last 15 minutes (simple heuristic;
// swap for real session tracking if you need precision).
router.get('/users/active', async (req, res) => {
  const rows = await db.prepare(
    `SELECT id, name, email, last_login_at FROM users
     WHERE last_login_at IS NOT NULL AND last_login_at >= datetime('now', '-15 minutes')
     ORDER BY last_login_at DESC`
  ).all();
  res.json({ active_users: rows });
});

/* ============================================================
   PAYMENTS / ORDERS ("who has applied for pay when you succeed")
============================================================ */
router.get('/orders', async (req, res) => {
  const rows = await db.prepare(
    `SELECT o.*, c.title AS course_title,
            (SELECT razorpay_payment_id FROM payments WHERE order_id = o.id) AS razorpay_payment_id
     FROM orders o LEFT JOIN courses c ON c.id = o.course_id ORDER BY o.created_at DESC`
  ).all();
  res.json({ orders: rows });
});

/* ============================================================
   MODULES CRUD
============================================================ */
router.get('/modules', async (req, res) => {
  const { course_id } = req.query;
  const modules = course_id === 'unassigned'
    ? await db.prepare('SELECT * FROM modules WHERE course_id IS NULL ORDER BY order_index ASC, id ASC').all()
    : course_id
    ? await db.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY order_index ASC, id ASC').all(course_id)
    : await db.prepare('SELECT * FROM modules ORDER BY course_id ASC, order_index ASC, id ASC').all();
  res.json({ modules });
});

router.post('/modules', async (req, res) => {
  const { title, description, order_index, course_id } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  if (!course_id) return res.status(400).json({ error: 'Pick the course this module belongs to.' });
  const maxRow = await db.prepare('SELECT MAX(order_index) AS m FROM modules WHERE course_id = ?').get(course_id);
  const maxOrder = maxRow ? maxRow.m : null;
  const info = await db.prepare('INSERT INTO modules (course_id, title, description, order_index) VALUES (?, ?, ?, ?)')
    .run(course_id, title, description || '', order_index ?? ((maxOrder ?? -1) + 1));
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/modules/:id', async (req, res) => {
  const { title, description, order_index, published, course_id } = req.body || {};
  const existing = await db.prepare('SELECT * FROM modules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Module not found.' });
  await db.prepare('UPDATE modules SET title = ?, description = ?, order_index = ?, published = ?, course_id = ? WHERE id = ?').run(
    title ?? existing.title,
    description ?? existing.description,
    order_index ?? existing.order_index,
    published !== undefined ? (published ? 1 : 0) : existing.published,
    course_id ?? existing.course_id,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/modules/:id', async (req, res) => {
  await db.prepare('DELETE FROM modules WHERE id = ?').run(req.params.id); // videos cascade
  res.json({ ok: true });
});

/* ============================================================
   VIDEOS CRUD (add/edit videos — paste the R2 .m3u8 URL here after
   following the README "Upload & convert videos" steps)
============================================================ */
router.get('/videos', async (req, res) => {
  const { module_id } = req.query;
  const videos = module_id
    ? await db.prepare('SELECT * FROM videos WHERE module_id = ? ORDER BY order_index ASC').all(module_id)
    : await db.prepare('SELECT * FROM videos ORDER BY module_id ASC, order_index ASC').all();
  res.json({ videos });
});

router.post('/videos', async (req, res) => {
  const { module_id, title, description, hls_url, thumbnail_url, duration_secs, order_index, encryption_key_b64, is_preview } = req.body || {};
  if (!module_id || !title) return res.status(400).json({ error: 'module_id and title are required.' });
  const maxRow = await db.prepare('SELECT MAX(order_index) AS m FROM videos WHERE module_id = ?').get(module_id);
  const maxOrder = maxRow ? maxRow.m : null;
  const info = await db.prepare(
    `INSERT INTO videos (module_id, title, description, order_index, duration_secs, hls_url, thumbnail_url, encryption_key_b64, is_preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(module_id, title, description || '', order_index ?? ((maxOrder ?? -1) + 1), Number(duration_secs) || 0, hls_url || '', thumbnail_url || '', encryption_key_b64 || null, is_preview ? 1 : 0);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/videos/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Video not found.' });
  const b = req.body || {};
  await db.prepare(
    `UPDATE videos SET title=?, description=?, hls_url=?, thumbnail_url=?, duration_secs=?, order_index=?, published=?, encryption_key_b64=?, is_preview=? WHERE id=?`
  ).run(
    b.title ?? existing.title,
    b.description ?? existing.description,
    b.hls_url ?? existing.hls_url,
    b.thumbnail_url ?? existing.thumbnail_url,
    b.duration_secs !== undefined ? (Number(b.duration_secs) || 0) : existing.duration_secs,
    b.order_index ?? existing.order_index,
    b.published !== undefined ? (b.published ? 1 : 0) : existing.published,
    b.encryption_key_b64 ?? existing.encryption_key_b64,
    b.is_preview !== undefined ? (b.is_preview ? 1 : 0) : existing.is_preview,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/videos/:id', async (req, res) => {
  await db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});


/* ============================================================
   COURSES CRUD
============================================================ */
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
const COURSE_FIELDS = ['title', 'slug', 'subtitle', 'description', 'category', 'level', 'language', 'outcomes', 'price', 'mrp', 'thumbnail_url', 'theme', 'order_index', 'published'];

router.get('/courses', async (req, res) => {
  const courses = await catalog.listCourses({ includeDrafts: true });
  const buyers = await db.prepare('SELECT course_id, COUNT(*) AS n FROM enrollments GROUP BY course_id').all();
  const byId = new Map(buyers.map(b => [b.course_id, b.n]));
  res.json({ courses: courses.map(c => ({ ...c, buyers: byId.get(c.id) || 0 })) });
});

router.post('/courses', async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Title is required.' });
  const slug = slugify(b.slug || b.title);
  if (!slug) return res.status(400).json({ error: 'Enter a valid URL slug.' });
  if (await db.prepare('SELECT id FROM courses WHERE slug = ?').get(slug)) return res.status(409).json({ error: 'Another course already uses this URL slug.' });
  const max = await db.prepare('SELECT MAX(order_index) AS m FROM courses').get();
  const info = await db.prepare(
    `INSERT INTO courses (slug, title, subtitle, description, category, level, language, outcomes, price, mrp, thumbnail_url, theme, order_index, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(slug, b.title.trim(), b.subtitle || '', b.description || '', b.category || '', b.level || 'Beginner', b.language || 'Hindi + English',
    b.outcomes || '', Number(b.price) || 0, b.mrp ? Number(b.mrp) : null, b.thumbnail_url || '', Number(b.theme) || 0,
    b.order_index ?? ((max && max.m !== null ? max.m : -1) + 1), b.published === undefined ? 1 : (b.published ? 1 : 0));
  res.json({ ok: true, id: info.lastInsertRowid, slug });
});

router.put('/courses/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Course not found.' });
  const b = req.body || {};
  const next = { ...existing };
  for (const f of COURSE_FIELDS) if (b[f] !== undefined) next[f] = b[f];
  next.slug = slugify(next.slug || next.title);
  if (next.slug !== existing.slug && await db.prepare('SELECT id FROM courses WHERE slug = ? AND id != ?').get(next.slug, existing.id)) {
    return res.status(409).json({ error: 'Another course already uses this URL slug.' });
  }
  await db.prepare(
    `UPDATE courses SET slug=?, title=?, subtitle=?, description=?, category=?, level=?, language=?, outcomes=?, price=?, mrp=?, thumbnail_url=?, theme=?, order_index=?, published=? WHERE id=?`
  ).run(next.slug, next.title, next.subtitle, next.description, next.category, next.level, next.language, next.outcomes,
    Number(next.price) || 0, next.mrp ? Number(next.mrp) : null, next.thumbnail_url, Number(next.theme) || 0,
    Number(next.order_index) || 0, next.published ? 1 : 0, existing.id);
  res.json({ ok: true });
});

router.delete('/courses/:id', async (req, res) => {
  const buyers = await db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?').get(req.params.id);
  if (buyers.n > 0) return res.status(409).json({ error: `${buyers.n} student(s) bought this course. Unpublish it instead of deleting.` });
  const mods = await db.prepare('SELECT COUNT(*) AS n FROM modules WHERE course_id = ?').get(req.params.id);
  if (mods.n > 0) return res.status(409).json({ error: 'Delete or move this course\'s modules first.' });
  await db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ============================================================
   SETTINGS (bundle price etc.)
============================================================ */
router.get('/settings', async (req, res) => {
  res.json({ settings: await catalog.getSettings() });
});
router.put('/settings', async (req, res) => {
  const allowed = ['bundle_title', 'bundle_price', 'bundle_mrp', 'bundle_tagline'];
  const b = req.body || {};
  if (b.bundle_price !== undefined && !(Number(b.bundle_price) > 0)) return res.status(400).json({ error: 'Enter a valid bundle price.' });
  for (const k of allowed) if (b[k] !== undefined) await catalog.setSetting(k, b[k]);
  res.json({ ok: true });
});

/* ============================================================
   MANUAL ACCESS (offline payments, scholarships, refunds)
============================================================ */
router.post('/users/:id/access', async (req, res) => {
  const { all_access, course_id, revoke } = req.body || {};
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (all_access !== undefined) {
    await db.prepare(`UPDATE users SET all_access = ?, is_enrolled = CASE WHEN ? = 1 THEN 1 ELSE is_enrolled END,
                      enrolled_at = COALESCE(enrolled_at, datetime('now')) WHERE id = ?`).run(all_access ? 1 : 0, all_access ? 1 : 0, user.id);
  }
  if (course_id) {
    if (revoke) await db.prepare('DELETE FROM enrollments WHERE user_id = ? AND course_id = ?').run(user.id, course_id);
    else {
      await db.prepare('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)').run(user.id, course_id);
      await db.prepare(`UPDATE users SET is_enrolled = 1, enrolled_at = COALESCE(enrolled_at, datetime('now')) WHERE id = ?`).run(user.id);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
