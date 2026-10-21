// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const db = require('./db');
const { attachUser, requireAuth, requireAdmin } = require('./middleware/auth');

const publicRoutes = require('./routes/public');
const lmsRoutes = require('./routes/lms');
const adminRoutes = require('./routes/admin');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(helmet({
  contentSecurityPolicy: false // the marketing pages use inline styles/scripts; tighten this once you finalize your CDN list
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cors({ origin: process.env.APP_URL || true, credentials: true }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cookieParser());
app.use(attachUser);

/* ============================================================
   API ROUTES
============================================================ */
app.use('/api', publicRoutes);
app.use('/api/lms', lmsRoutes);
app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

/* ============================================================
   PAGE ACCESS RULES
   - Logged-out visitors see the storefront: / (no prices), /courses,
     /pricing and /course/:slug.
   - A logged-in user always lands in the app (/lms) instead — the app has
     its own course catalogue with Buy buttons.
   - /pay needs a login; logged-out buyers are sent to /auth and come
     straight back to the same checkout afterwards (?next=).
   Gates are registered BEFORE the plain file routes: Express runs
   handlers in order, and a route that responds stops the chain.
============================================================ */
const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

// The selection-round form (PWYS) is retired — keep old links working.
app.get(['/pwys', '/pwys.html'], (req, res) => res.redirect(301, '/'));

app.get(['/', '/index.html', '/auth', '/auth.html', '/courses', '/courses.html', '/pricing', '/pricing.html'], (req, res, next) => {
  if (req.user) {
    const next_ = typeof req.query.next === 'string' && req.query.next.startsWith('/pay') ? req.query.next : '/lms';
    return res.redirect(next_);
  }
  next();
});

app.get('/course/:slug', (req, res) => {
  if (req.user) return res.redirect('/lms#course/' + encodeURIComponent(req.params.slug));
  res.sendFile(path.join(PUBLIC_DIR, 'course.html'));
});

app.get(['/pay', '/pay.html'], (req, res) => {
  if (!req.user) return res.redirect('/auth?next=' + encodeURIComponent(req.originalUrl));
  res.sendFile(path.join(PUBLIC_DIR, 'pay.html'));
});

app.get(['/lms', '/lms.html'], (req, res) => {
  if (!req.user) return res.redirect('/auth');
  res.sendFile(path.join(PUBLIC_DIR, 'lms.html'));
});

app.get(['/admin', '/admin.html'], (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.redirect('/admin-login');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/courses', page('courses.html'));
app.get('/pricing', page('pricing.html'));
app.get('/auth', page('auth.html'));
app.get('/admin-login', page('admin-login.html'));

/* ============================================================
   STATIC FILES
   extensions:['html'] is a safety net — a request that somehow
   bypasses the explicit routes above still resolves /pay or /pwys
   etc. to the right .html file.
============================================================ */
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Fallback 404 — a real not-found page, not a silent redirect to the homepage.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  res.status(500).send('Something went wrong.');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Upskill10x running at http://localhost:${PORT}`));
}

module.exports = app; // exported for Vercel's serverless entry (see api/index.js)
