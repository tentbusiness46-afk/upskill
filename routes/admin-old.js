// routes/admin.js
// All routes here require an authenticated admin (see server.js mount).
const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();
const COUPON_PRICE = Number(process.env.COUPON_PRICE || 999);

/* ============================================================
   APPLICATIONS (from the selection round / pwys.html)
============================================================ */
router.get('/applications', (req, res) => {
  const rows = db.prepare('SELECT * FROM applications ORDER BY submitted_at DESC').all();
  res.json({ applications: rows });
});

router.post('/applications/:id/approve', (req, res) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  // Generate a unique coupon code tied to this applicant.
  const code = 'EDGE-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  db.prepare(
    `INSERT INTO coupons (code, applicant_email, application_id, discount_price) VALUES (?, ?, ?, ?)`
  ).run(code, app.email, app.id, COUPON_PRICE);

  db.prepare(`UPDATE applications SET review_status = 'approved', coupon_code = ? WHERE id = ?`).run(code, app.id);

  res.json({ ok: true, coupon_code: code });
});

router.post('/applications/:id/reject', (req, res) => {
  const info = db.prepare(`UPDATE applications SET review_status = 'rejected' WHERE id = ?`).run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Application not found.' });
  res.json({ ok: true });
});

// Mark that you've emailed the coupon to the applicant (manual send for now —
// see README "Email" section to wire up real SMTP sending later).
router.post('/applications/:id/mark-emailed', (req, res) => {
  const info = db.prepare(`UPDATE applications SET coupon_emailed = 1 WHERE id = ?`).run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Application not found.' });
  res.json({ ok: true });
});

/* ============================================================
   USERS / ENROLLMENTS / ACTIVE USERS
============================================================ */
router.get('/users', (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, email, phone, role, is_enrolled, enrolled_at, last_login_at, created_at
     FROM users ORDER BY created_at DESC`
  ).all();
  res.json({ users: rows });
});

// "Currently active" = logged in within the last 15 minutes (simple heuristic;
// swap for real session tracking if you need precision).
router.get('/users/active', (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, email, last_login_at FROM users
     WHERE last_login_at IS NOT NULL AND last_login_at >= datetime('now', '-15 minutes')
     ORDER BY last_login_at DESC`
  ).all();
  res.json({ active_users: rows });
});

/* ============================================================
   PAYMENTS / ORDERS ("who has applied for pay when you succeed")
============================================================ */
router.get('/orders', (req, res) => {
  const rows = db.prepare(
    `SELECT o.*, (SELECT razorpay_payment_id FROM payments WHERE order_id = o.id) AS razorpay_payment_id
     FROM orders o ORDER BY o.created_at DESC`
  ).all();
  res.json({ orders: rows });
});

/* ============================================================
   MODULES CRUD
============================================================ */
router.get('/modules', (req, res) => {
  const modules = db.prepare('SELECT * FROM modules ORDER BY order_index ASC').all();
  res.json({ modules });
});

router.post('/modules', (req, res) => {
  const { title, description, order_index } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const maxOrder = db.prepare('SELECT MAX(order_index) AS m FROM modules').get().m;
  const info = db.prepare('INSERT INTO modules (title, description, order_index) VALUES (?, ?, ?)')
    .run(title, description || '', order_index ?? ((maxOrder ?? -1) + 1));
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/modules/:id', (req, res) => {
  const { title, description, order_index, published } = req.body || {};
  const existing = db.prepare('SELECT * FROM modules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Module not found.' });
  db.prepare('UPDATE modules SET title = ?, description = ?, order_index = ?, published = ? WHERE id = ?').run(
    title ?? existing.title,
    description ?? existing.description,
    order_index ?? existing.order_index,
    published !== undefined ? (published ? 1 : 0) : existing.published,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/modules/:id', (req, res) => {
  db.prepare('DELETE FROM modules WHERE id = ?').run(req.params.id); // videos cascade
  res.json({ ok: true });
});

/* ============================================================
   VIDEOS CRUD (add/edit videos — paste the R2 .m3u8 URL here after
   following the README "Upload & convert videos" steps)
============================================================ */
router.get('/videos', (req, res) => {
  const { module_id } = req.query;
  const videos = module_id
    ? db.prepare('SELECT * FROM videos WHERE module_id = ? ORDER BY order_index ASC').all(module_id)
    : db.prepare('SELECT * FROM videos ORDER BY module_id ASC, order_index ASC').all();
  res.json({ videos });
});

router.post('/videos', (req, res) => {
  const { module_id, title, description, hls_url, thumbnail_url, duration_secs, order_index, encryption_key_b64 } = req.body || {};
  if (!module_id || !title) return res.status(400).json({ error: 'module_id and title are required.' });
  const maxOrder = db.prepare('SELECT MAX(order_index) AS m FROM videos WHERE module_id = ?').get(module_id).m;
  const info = db.prepare(
    `INSERT INTO videos (module_id, title, description, order_index, duration_secs, hls_url, thumbnail_url, encryption_key_b64)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(module_id, title, description || '', order_index ?? ((maxOrder ?? -1) + 1), duration_secs || 0, hls_url || '', thumbnail_url || '', encryption_key_b64 || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/videos/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Video not found.' });
  const b = req.body || {};
  db.prepare(
    `UPDATE videos SET title=?, description=?, hls_url=?, thumbnail_url=?, duration_secs=?, order_index=?, published=?, encryption_key_b64=? WHERE id=?`
  ).run(
    b.title ?? existing.title,
    b.description ?? existing.description,
    b.hls_url ?? existing.hls_url,
    b.thumbnail_url ?? existing.thumbnail_url,
    b.duration_secs ?? existing.duration_secs,
    b.order_index ?? existing.order_index,
    b.published !== undefined ? (b.published ? 1 : 0) : existing.published,
    b.encryption_key_b64 ?? existing.encryption_key_b64,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/videos/:id', (req, res) => {
  db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
