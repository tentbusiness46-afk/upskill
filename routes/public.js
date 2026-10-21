// routes/public.js
// Public catalog, auth, coupons and Razorpay checkout.
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { setAuthCookie, clearAuthCookie } = require('../middleware/auth');
const { razorpay, verifyPaymentSignature, verifyWebhookSignature } = require('../utils/razorpay');
const catalog = require('../utils/catalog');

const router = express.Router();

/* ============================================================
   1) CATALOG  (landing page, course pages, LMS "Explore")
============================================================ */
router.get('/catalog', async (req, res) => {
  const [courses, bundle] = await Promise.all([catalog.listCourses(), catalog.getBundle()]);
  res.json({ courses: courses.map(catalog.publicCourse), bundle });
});

router.get('/courses/:slug', async (req, res) => {
  const course = await catalog.findCourse(req.params.slug);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  const [all, curriculum, bundle] = await Promise.all([
    catalog.listCourses(), catalog.courseCurriculum(course.id), catalog.getBundle()
  ]);
  const withStats = all.find(c => c.id === course.id) || course;
  let owned = false;
  if (req.user) owned = catalog.ownsCourse(await catalog.userAccess(req.user.id), course.id);
  res.json({
    course: catalog.publicCourse(withStats),
    curriculum,
    bundle,
    course_count: all.length,
    owned
  });
});

// Free preview lessons can be watched without an account.
router.get('/preview/:id', async (req, res) => {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ? AND published = 1 AND is_preview = 1').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'This lesson is not a free preview.' });
  res.json({ id: video.id, title: video.title, description: video.description, hls_url: video.hls_url });
});

/* ============================================================
   1b) CURRICULUM PDF LEAD CAPTURE (kept for old links)
============================================================ */
router.post('/download-curriculum', async (req, res) => {
  const { name, email, phone } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Missing required fields' });
  try {
    await db.prepare(`INSERT INTO curriculum_downloads (name, email, phone) VALUES (?, ?, ?)`)
      .run(name.trim(), email.trim().toLowerCase(), phone || null);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save details' });
  }
});

router.get('/curriculum-pdf', (req, res) => {
  const filePath = path.join(__dirname, '..', 'private', 'curriculum.pdf');
  res.download(filePath, 'Upskill10x-Curriculum.pdf', (err) => {
    if (err && !res.headersSent) res.status(404).send('Curriculum PDF is not available right now.');
  });
});

/* ============================================================
   2) REGISTER / LOGIN / LOGOUT / ME
============================================================ */
router.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Please fill all fields (password min 6 characters).' });
  }
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

  const hash = await bcrypt.hash(password, 12);
  const info = await db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, last_login_at) VALUES (?, ?, ?, ?, 'student', datetime('now'))`
  ).run(name.trim(), email.toLowerCase(), phone || null, hash);

  const user = { id: info.lastInsertRowid, name: name.trim(), email: email.toLowerCase(), role: 'student' };
  setAuthCookie(res, user);
  res.json({ ok: true, user: { name: user.name, email: user.email } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

  await db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  setAuthCookie(res, user);
  res.json({ ok: true, user: { name: user.name, email: user.email, role: user.role } });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = await db.prepare(
    'SELECT id, name, email, phone, role, is_enrolled, all_access, enrolled_at, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.json({ user: null });
  const access = await catalog.userAccess(user.id);
  res.json({
    user: {
      ...user,
      all_access: access.allAccess,
      owned_course_ids: [...access.courseIds],
      has_purchase: catalog.hasAnyPurchase(access)
    }
  });
});

/* ============================================================
   3) CHECKOUT
   The thing being bought is described as:
     { item: 'bundle' }                     -> All-Access Pass
     { item: 'course', course: <id|slug> }  -> one course
============================================================ */
async function resolveItem(body) {
  if (body.item === 'bundle') return { type: 'bundle' };
  if (body.item === 'course' && body.course) {
    const course = await catalog.findCourse(body.course);
    if (course) return { type: 'course', course };
  }
  return null;
}

router.get('/checkout-item', async (req, res) => {
  const item = await resolveItem({ item: req.query.item, course: req.query.course });
  if (!item) return res.status(404).json({ error: 'Nothing to buy here.' });
  const bundle = await catalog.getBundle();
  const courses = await catalog.listCourses();
  let owned = false;
  if (req.user) {
    const access = await catalog.userAccess(req.user.id);
    owned = access.allAccess || (item.type === 'course' && access.courseIds.has(item.course.id));
  }
  if (item.type === 'bundle') {
    return res.json({ item: 'bundle', title: bundle.title, subtitle: bundle.tagline, price: bundle.price, mrp: bundle.mrp, course_count: courses.length, owned, bundle });
  }
  const c = courses.find(x => x.id === item.course.id) || item.course;
  res.json({ item: 'course', course: catalog.publicCourse(c), title: c.title, subtitle: c.subtitle, price: c.price, mrp: c.mrp, owned, bundle, course_count: courses.length });
});

router.post('/validate-coupon', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false, message: 'Enter a coupon code.' });
  const item = (await resolveItem(req.body || {})) || { type: 'bundle' };
  const priced = await catalog.priceFor(item, code);
  if (!priced.couponCode) return res.json({ valid: false, message: priced.couponMessage || 'This coupon code is invalid.' });
  res.json({ valid: true, price: priced.amount, base: priced.base, message: priced.couponMessage });
});

router.post('/create-order', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  const { name, email, phone, coupon } = req.body || {};
  if (!name || !email || !phone) return res.status(400).json({ error: 'Missing customer details.' });

  const item = await resolveItem(req.body || {});
  if (!item) return res.status(400).json({ error: 'Choose a course or the All-Access Pass.' });

  const access = await catalog.userAccess(req.user.id);
  if (access.allAccess) return res.status(409).json({ error: 'You already have the All-Access Pass.' });
  if (item.type === 'course' && access.courseIds.has(item.course.id)) {
    return res.status(409).json({ error: 'You already own this course.' });
  }

  const priced = await catalog.priceFor(item, coupon);
  const label = item.type === 'bundle' ? 'All-Access Pass' : item.course.title;

  try {
    const order = await razorpay.orders.create({
      amount: priced.amount * 100,
      currency: 'INR',
      receipt: `u10x_${Date.now()}`,
      notes: { name, email, phone, item: label, coupon: priced.couponCode || '' }
    });

    await db.prepare(
      `INSERT INTO orders (razorpay_order_id, user_id, name, email, phone, amount, currency, coupon_code, status, item_type, course_id)
       VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, 'created', ?, ?)`
    ).run(order.id, req.user.id, name, email, phone, order.amount, priced.couponCode,
      item.type, item.type === 'course' ? item.course.id : null);

    res.json({ id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID, label });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    res.status(500).json({ error: 'Could not create payment order.' });
  }
});

// SQL statements that grant whatever an order paid for.
function grantStatements(order, userId) {
  if (!userId) return [];
  const stmts = [{
    sql: `UPDATE users SET is_enrolled = 1, enrolled_at = COALESCE(enrolled_at, datetime('now')) WHERE id = ?`,
    args: [userId]
  }];
  if ((order.item_type || 'bundle') === 'bundle') {
    stmts.push({ sql: 'UPDATE users SET all_access = 1 WHERE id = ?', args: [userId] });
  } else if (order.course_id) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO enrollments (user_id, course_id, order_id) VALUES (?, ?, ?)',
      args: [userId, order.course_id, order.id]
    });
  }
  return stmts;
}

async function orderUserId(order, req) {
  if (order.user_id) return order.user_id;
  if (req && req.user) return req.user.id;
  const byEmail = await db.prepare('SELECT id FROM users WHERE email = ?').get(order.email);
  return byEmail ? byEmail.id : null;
}

router.post('/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, message: 'Missing payment details.' });
  }
  if (!verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
    return res.status(400).json({ verified: false, message: 'Signature verification failed.' });
  }
  const order = await db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(razorpay_order_id);
  if (!order) return res.status(404).json({ verified: false, message: 'Order not found.' });

  try {
    const userId = await orderUserId(order, req);
    const already = await db.prepare('SELECT id FROM payments WHERE razorpay_payment_id = ?').get(razorpay_payment_id);
    const statements = [{ sql: `UPDATE orders SET status = 'paid' WHERE id = ?`, args: [order.id] }];
    if (!already) {
      statements.push({ sql: `INSERT INTO payments (order_id, razorpay_payment_id, razorpay_signature) VALUES (?, ?, ?)`, args: [order.id, razorpay_payment_id, razorpay_signature] });
    }
    statements.push(...grantStatements(order, userId));
    await db.transaction(statements);
    res.json({ verified: true, item_type: order.item_type, course_id: order.course_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ verified: false, message: 'Could not finalize your purchase. Contact support with your payment ID.' });
  }
});

/* Razorpay webhook — backup path if the buyer closes the tab before
   /verify-payment runs. Subscribe to "payment.captured". */
router.post('/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !req.rawBody || !verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  const event = req.body;
  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const order = await db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(payment.order_id);
    if (order && order.status !== 'paid') {
      const already = await db.prepare('SELECT id FROM payments WHERE razorpay_payment_id = ?').get(payment.id);
      const userId = await orderUserId(order, null);
      const statements = [{ sql: `UPDATE orders SET status = 'paid' WHERE id = ?`, args: [order.id] }];
      if (!already) {
        statements.push({ sql: `INSERT INTO payments (order_id, razorpay_payment_id, razorpay_signature) VALUES (?, ?, ?)`, args: [order.id, payment.id, signature] });
      }
      statements.push(...grantStatements(order, userId));
      await db.transaction(statements);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
