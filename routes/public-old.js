// routes/public.js
// Endpoints used by index.html, pwys.html, auth.html and pay.html.
// These exact paths are already wired up in the frontend JS — do not
// rename them unless you also update the corresponding fetch() calls.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { setAuthCookie, clearAuthCookie } = require('../middleware/auth');
const { razorpay, verifyPaymentSignature, verifyWebhookSignature } = require('../utils/razorpay');

const router = express.Router();

const FULL_PRICE = Number(process.env.FULL_PRICE || 9999);
const COUPON_PRICE = Number(process.env.COUPON_PRICE || 999);

/* ============================================================
   1) SELECTION-ROUND APPLICATION  (pwys.html)
   POST /api/submit-application
============================================================ */
router.post('/submit-application', (req, res) => {
  const {
    name, whatsapp, email, status, city,
    obstacle, hours_and_goal, commitment, has_laptop, submitted_at
  } = req.body || {};

  if (!name || !email || !obstacle || !hours_and_goal) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    db.prepare(
      `INSERT INTO applications
        (name, whatsapp, email, status_field, city, obstacle, hours_and_goal, commitment, has_laptop, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name, whatsapp || null, email.toLowerCase(), status || null, city || null,
      obstacle, hours_and_goal, commitment || null, has_laptop || null,
      submitted_at || new Date().toISOString()
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save application' });
  }
});

/* ============================================================
   2) REGISTER / LOGIN / LOGOUT / ME   (auth.html)
============================================================ */
router.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Please fill all fields (password min 6 characters).' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

  const hash = await bcrypt.hash(password, 12);
  const info = db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'student')`
  ).run(name, email.toLowerCase(), phone || null, hash);

  const user = { id: info.lastInsertRowid, name, email: email.toLowerCase(), role: 'student' };
  setAuthCookie(res, user);
  res.json({ ok: true, user: { name: user.name, email: user.email, is_enrolled: false } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  setAuthCookie(res, user);
  res.json({
    ok: true,
    user: { name: user.name, email: user.email, role: user.role, is_enrolled: !!user.is_enrolled }
  });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = db.prepare('SELECT id, name, email, role, is_enrolled, enrolled_at, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: user || null });
});

/* ============================================================
   3) COUPON VALIDATION   (pay.html)
   POST /api/validate-coupon  { code }
============================================================ */
router.post('/validate-coupon', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false, message: 'Enter a coupon code.' });

  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code.trim().toUpperCase());
  if (!coupon) return res.json({ valid: false, message: 'This coupon code is invalid or has expired.' });
  if (coupon.is_used) return res.json({ valid: false, message: 'This coupon has already been used.' });
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.json({ valid: false, message: 'This coupon has expired.' });
  }

  res.json({ valid: true, price: coupon.discount_price });
});

/* ============================================================
   4) CREATE RAZORPAY ORDER   (pay.html)
   POST /api/create-order  { name, email, phone, coupon }
   Server re-validates the coupon and computes the REAL amount —
   never trust a price sent from the browser.
============================================================ */
router.post('/create-order', async (req, res) => {
  const { name, email, phone, coupon } = req.body || {};
  if (!name || !email || !phone) return res.status(400).json({ error: 'Missing customer details.' });

  let amountRupees = FULL_PRICE;
  let couponCode = null;

  if (coupon) {
    const row = db.prepare('SELECT * FROM coupons WHERE code = ?').get(coupon.trim().toUpperCase());
    const validNow = row && !row.is_used && (!row.expires_at || new Date(row.expires_at) >= new Date());
    if (validNow) {
      amountRupees = row.discount_price;
      couponCode = row.code;
    }
    // If invalid, silently fall back to full price — the UI already
    // told the user the coupon didn't apply at the validate step.
  }

  try {
    const order = await razorpay.orders.create({
      amount: amountRupees * 100, // paise
      currency: 'INR',
      receipt: `ee_${Date.now()}`,
      notes: { name, email, phone, coupon: couponCode || '' }
    });

    db.prepare(
      `INSERT INTO orders (razorpay_order_id, user_id, name, email, phone, amount, currency, coupon_code, status)
       VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, 'created')`
    ).run(order.id, req.user ? req.user.id : null, name, email, phone, order.amount, couponCode);

    res.json({ id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    res.status(500).json({ error: 'Could not create payment order.' });
  }
});

/* ============================================================
   5) VERIFY PAYMENT   (pay.html)
   POST /api/verify-payment
   { razorpay_payment_id, razorpay_order_id, razorpay_signature, customer }
============================================================ */
router.post('/verify-payment', (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, customer } = req.body || {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, message: 'Missing payment details.' });
  }

  const valid = verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
  if (!valid) return res.status(400).json({ verified: false, message: 'Signature verification failed.' });

  const order = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(razorpay_order_id);
  if (!order) return res.status(404).json({ verified: false, message: 'Order not found.' });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(order.id);
    db.prepare(
      `INSERT INTO payments (order_id, razorpay_payment_id, razorpay_signature) VALUES (?, ?, ?)`
    ).run(order.id, razorpay_payment_id, razorpay_signature);

    if (order.coupon_code) {
      db.prepare(
        `UPDATE coupons SET is_used = 1, used_by_user_id = ? WHERE code = ?`
      ).run(req.user ? req.user.id : null, order.coupon_code);
    }

    // Mark the user (by session if logged in, else by email match) enrolled.
    const userId = req.user ? req.user.id : (db.prepare('SELECT id FROM users WHERE email = ?').get(order.email) || {}).id;
    if (userId) {
      db.prepare(`UPDATE users SET is_enrolled = 1, enrolled_at = datetime('now') WHERE id = ?`).run(userId);
    }
  });

  try {
    tx();
    res.json({ verified: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ verified: false, message: 'Could not finalize enrollment. Contact support with your payment ID.' });
  }
});

/* ============================================================
   6) RAZORPAY WEBHOOK  (backup path — fires even if the user closes
   the tab before /api/verify-payment runs in the browser)
   POST /api/webhook/razorpay
   Configure this URL in Razorpay Dashboard > Settings > Webhooks,
   subscribed to the "payment.captured" event, using
   RAZORPAY_WEBHOOK_SECRET as the webhook secret.
============================================================ */
router.post('/webhook/razorpay', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !req.rawBody || !verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body;
  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const order = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(payment.order_id);
    if (order && order.status !== 'paid') {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(order.id);
        const already = db.prepare('SELECT id FROM payments WHERE razorpay_payment_id = ?').get(payment.id);
        if (!already) {
          db.prepare(`INSERT INTO payments (order_id, razorpay_payment_id, razorpay_signature) VALUES (?, ?, ?)`)
            .run(order.id, payment.id, signature);
        }
        if (order.coupon_code) {
          db.prepare(`UPDATE coupons SET is_used = 1 WHERE code = ?`).run(order.coupon_code);
        }
        const userRow = order.user_id ? { id: order.user_id } : db.prepare('SELECT id FROM users WHERE email = ?').get(order.email);
        if (userRow) {
          db.prepare(`UPDATE users SET is_enrolled = 1, enrolled_at = COALESCE(enrolled_at, datetime('now')) WHERE id = ?`).run(userRow.id);
        }
      });
      tx();
    }
  }

  res.json({ ok: true });
});

module.exports = router;
