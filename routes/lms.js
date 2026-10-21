// routes/lms.js
// Student app API. Every logged-in user can browse all courses; lessons
// play when the user owns the course (or has the All-Access Pass), or when
// the lesson is marked as a free preview. Within an owned course, module N
// unlocks after module N-1 is finished.
const express = require('express');
const cheerio = require('cheerio');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const catalog = require('../utils/catalog');

const router = express.Router();

// AES-128 key for the HLS segments. The .m3u8/.ts on R2 are public but
// useless without this, so this is the real access check. Registered
// before requireAuth so free preview lessons also play when logged out.
router.get('/videos/:id/key', async (req, res) => {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ? AND published = 1').get(req.params.id);
  if (!video || !video.encryption_key_b64) return res.status(404).end();
  if (!video.is_preview) {
    if (!req.user) return res.status(401).end();
    const check = await catalog.canWatch(req.user.id, video);
    if (!check.ok) return res.status(403).end();
  }
  res.set('Content-Type', 'application/octet-stream');
  res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(video.encryption_key_b64, 'base64'));
});

router.use(requireAuth);

// Community and jobs are for students who have bought something.
async function requirePurchase(req, res, next) {
  const access = await catalog.userAccess(req.user.id);
  if (!catalog.hasAnyPurchase(access)) {
    return res.status(403).json({ error: 'Buy any course to unlock this.', needsPurchase: true });
  }
  next();
}

const IST_DATE = `date(completed_at, '+5 hours', '+30 minutes')`;

function istToday(offsetDays = 0) {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 - offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function learningStats(userId) {
  const days = await db.prepare(
    `SELECT ${IST_DATE} AS d, COUNT(*) AS n FROM progress
     WHERE user_id = ? AND completed = 1 AND completed_at IS NOT NULL
       AND completed_at >= datetime('now', '-160 days')
     GROUP BY d ORDER BY d ASC`
  ).all(userId);
  const set = new Set(days.map(r => r.d));
  // Streak: consecutive days with at least one finished lesson, ending
  // today (or yesterday, so the streak isn't "lost" before you study today).
  let streak = 0;
  let offset = set.has(istToday(0)) ? 0 : 1;
  while (set.has(istToday(offset))) { streak++; offset++; }
  const total = await db.prepare('SELECT COUNT(*) AS c FROM progress WHERE user_id = ? AND completed = 1').get(userId);
  const today = days.find(r => r.d === istToday(0));
  return {
    streak,
    lessons_done: total.c,
    lessons_today: today ? today.n : 0,
    activity: days.map(r => ({ date: r.d, count: r.n })),
    today: istToday(0)
  };
}

/* ============================================================
   OVERVIEW — everything the Home and Courses tabs need
============================================================ */
router.get('/overview', async (req, res) => {
  const [user, access, courses, bundle, stats] = await Promise.all([
    db.prepare('SELECT id, name, email, phone, created_at FROM users WHERE id = ?').get(req.user.id),
    catalog.userAccess(req.user.id),
    catalog.listCourses(),
    catalog.getBundle(),
    learningStats(req.user.id)
  ]);
  const doneRows = await db.prepare(
    'SELECT video_id, completed_at FROM progress WHERE user_id = ? AND completed = 1'
  ).all(req.user.id);
  const doneAt = new Map(doneRows.map(r => [r.video_id, r.completed_at]));

  const out = [];
  for (const c of courses) {
    const owned = catalog.ownsCourse(access, c.id);
    const item = { ...catalog.publicCourse(c), owned };
    if (owned) {
      const curriculum = await catalog.courseCurriculum(c.id);
      const vids = curriculum.flatMap(m => m.videos.map(v => ({ ...v, module_title: m.title })));
      const done = vids.filter(v => doneAt.has(v.id));
      const next = vids.find(v => !doneAt.has(v.id)) || null;
      const last = done.map(v => doneAt.get(v.id)).sort().pop() || null;
      item.progress = {
        done: done.length,
        total: vids.length,
        pct: vids.length ? Math.round((done.length / vids.length) * 100) : 0
      };
      item.next_video = next ? { id: next.id, title: next.title, module_title: next.module_title } : null;
      item.last_activity = last;
    }
    out.push(item);
  }

  res.json({
    user,
    all_access: access.allAccess,
    has_purchase: catalog.hasAnyPurchase(access),
    courses: out,
    bundle,
    stats
  });
});

/* ============================================================
   ONE COURSE — modules + lessons with lock state
============================================================ */
router.get('/courses/:id', async (req, res) => {
  const course = await catalog.findCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  const access = await catalog.userAccess(req.user.id);
  const owned = catalog.ownsCourse(access, course.id);
  const curriculum = await catalog.courseCurriculum(course.id);
  const { state, done } = await catalog.moduleLockState(req.user.id, course.id, curriculum);
  const all = await catalog.listCourses();
  const withStats = all.find(c => c.id === course.id) || course;

  const modules = curriculum.map(m => {
    const st = state.get(m.id);
    const unlocked = owned && (st.unlocked || access.isAdmin);
    return {
      ...m,
      unlocked,
      completed: st.completed,
      videos: m.videos.map(v => ({
        ...v,
        completed: done.has(v.id),
        playable: v.is_preview || unlocked
      }))
    };
  });
  const total = modules.reduce((n, m) => n + m.videos.length, 0);
  const completed = modules.reduce((n, m) => n + m.videos.filter(v => v.completed).length, 0);

  res.json({
    course: catalog.publicCourse(withStats),
    owned,
    all_access: access.allAccess,
    modules,
    progress: { done: completed, total, pct: total ? Math.round((completed / total) * 100) : 0 },
    bundle: await catalog.getBundle(),
    course_count: all.length
  });
});

/* ============================================================
   VIDEOS
============================================================ */
router.get('/videos/:id', async (req, res) => {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ? AND published = 1').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  const check = await catalog.canWatch(req.user.id, video);
  if (!check.ok) return res.status(403).json({ error: check.reason, needsPurchase: !!check.needsPurchase, course_id: check.courseId });

  // Neighbours inside the same course, for "Next lesson".
  const curriculum = await catalog.courseCurriculum(check.courseId);
  const flat = curriculum.flatMap(m => m.videos.map(v => ({ id: v.id, title: v.title, module: m.title })));
  const idx = flat.findIndex(v => v.id === video.id);
  const course = await catalog.findCourse(check.courseId, { includeDrafts: true });

  res.json({
    id: video.id,
    title: video.title,
    description: video.description,
    hls_url: video.hls_url,
    is_preview: !!video.is_preview,
    course: course ? { id: course.id, title: course.title, slug: course.slug } : null,
    module_title: idx >= 0 ? flat[idx].module : '',
    position: idx + 1,
    total: flat.length,
    prev: idx > 0 ? flat[idx - 1] : null,
    next: idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null
  });
});

router.post('/videos/:id/complete', async (req, res) => {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  const check = await catalog.canWatch(req.user.id, video);
  if (!check.ok) return res.status(403).json({ error: check.reason });
  await db.prepare(
    `INSERT INTO progress (user_id, video_id, completed, completed_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(user_id, video_id) DO UPDATE SET completed = 1, completed_at = COALESCE(progress.completed_at, datetime('now'))`
  ).run(req.user.id, video.id);
  res.json({ ok: true });
});

/* ============================================================
   COMMUNITY
============================================================ */
router.get('/community/threads', async (req, res) => {
  const threads = await db.prepare(
    `SELECT t.id, t.title, t.body, t.created_at, u.name AS author_name,
            (SELECT COUNT(*) FROM thread_posts p WHERE p.thread_id = t.id) AS reply_count
     FROM threads t JOIN users u ON u.id = t.user_id
     ORDER BY t.created_at DESC`
  ).all();
  const access = await catalog.userAccess(req.user.id);
  res.json({ enrolled: catalog.hasAnyPurchase(access), threads });
});

router.post('/community/threads', requirePurchase, async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Title and question body are required.' });
  const info = await db.prepare('INSERT INTO threads (user_id, title, body) VALUES (?, ?, ?)').run(req.user.id, title.trim(), body.trim());
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/community/threads/:id', requirePurchase, async (req, res) => {
  const thread = await db.prepare(
    `SELECT t.id, t.title, t.body, t.created_at, u.name AS author_name
     FROM threads t JOIN users u ON u.id = t.user_id WHERE t.id = ?`
  ).get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const posts = await db.prepare(
    `SELECT p.id, p.body, p.created_at, u.name AS author_name
     FROM thread_posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = ? ORDER BY p.created_at ASC`
  ).all(req.params.id);
  res.json({ thread, posts });
});

router.post('/community/threads/:id/reply', requirePurchase, async (req, res) => {
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Reply cannot be empty.' });
  const thread = await db.prepare('SELECT id FROM threads WHERE id = ?').get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  await db.prepare('INSERT INTO thread_posts (thread_id, user_id, body) VALUES (?, ?, ?)').run(req.params.id, req.user.id, body.trim());
  res.json({ ok: true });
});

/* ============================================================
   ACCOUNT
============================================================ */
router.get('/account', async (req, res) => {
  const user = await db.prepare('SELECT name, email, phone, enrolled_at, created_at FROM users WHERE id = ?').get(req.user.id);
  const purchases = await db.prepare(
    `SELECT o.id, o.amount, o.item_type, o.created_at, o.coupon_code, c.title AS course_title
     FROM orders o LEFT JOIN courses c ON c.id = o.course_id
     WHERE o.user_id = ? AND o.status = 'paid' ORDER BY o.created_at DESC`
  ).all(req.user.id);
  const access = await catalog.userAccess(req.user.id);
  res.json({ account: user, all_access: access.allAccess, purchases, stats: await learningStats(req.user.id) });
});

/* ============================================================
   JOBS — live from iDigitalpreneur's public job page, cached 10 min.
============================================================ */
const jobsCache = new Map();
const JOBS_CACHE_TTL_MS = 10 * 60 * 1000;

router.get('/jobs', requirePurchase, async (req, res) => {
  const search = (req.query.search || '').trim();
  const cacheKey = search.toLowerCase();
  const cached = jobsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return res.json({ jobs: cached.data });

  try {
    const url = `https://idigitalpreneur.com/job-page?offset=0&search=${encodeURIComponent(search)}&sort=newest`;
    const response = await fetch(url, {
      headers: { 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://idigitalpreneur.com/job-page' }
    });
    const data = await response.json();
    const $ = cheerio.load(data.html || '');
    const jobs = [];
    $('.jobInfor').each((i, el) => {
      const $el = $(el);
      const $link = $el.find('a.ViewDetails');
      jobs.push({
        id: $link.attr('data-id') || String(i),
        title: $link.attr('data-title') || $el.find('.title p').text().trim(),
        company: $link.attr('data-company') || $el.find('.title span').text().trim(),
        image: $link.attr('data-image') || $el.find('.images img').attr('src') || '',
        type: $link.attr('data-type') || '',
        experience: $link.attr('data-experience') || '',
        salary: $link.attr('data-package') || '',
        description: $el.find('.description').text().trim(),
        posted: $el.find('.posted .text p').text().trim(),
        link: $link.attr('data-link') || ''
      });
    });
    jobsCache.set(cacheKey, { data: jobs, expires: Date.now() + JOBS_CACHE_TTL_MS });
    res.json({ jobs });
  } catch (err) {
    console.error('Jobs fetch failed:', err);
    res.status(500).json({ error: 'Could not load jobs right now.' });
  }
});

module.exports = router;
