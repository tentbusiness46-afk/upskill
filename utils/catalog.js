// utils/catalog.js
// Everything about courses, the bundle, prices and who can watch what,
// shared by the public, LMS and admin routes.
const db = require('../db');

/* ---------------- settings ---------------- */
async function getSettings() {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s;
}
async function setSetting(key, value) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
async function getBundle() {
  const s = await getSettings();
  return {
    title: s.bundle_title || 'All-Access Pass',
    price: Number(s.bundle_price || 2999),
    mrp: Number(s.bundle_mrp || 0) || null,
    tagline: s.bundle_tagline || ''
  };
}

/* ---------------- courses ---------------- */
// Courses with lesson/module counts and total runtime. Published only
// unless includeDrafts is set (admin).
async function listCourses({ includeDrafts = false } = {}) {
  const courses = await db.prepare(
    `SELECT * FROM courses ${includeDrafts ? '' : 'WHERE published = 1'} ORDER BY order_index ASC, id ASC`
  ).all();
  const stats = await db.prepare(
    `SELECT m.course_id,
            COUNT(DISTINCT m.id) AS module_count,
            COUNT(v.id) AS lesson_count,
            COALESCE(SUM(v.duration_secs), 0) AS total_secs
     FROM modules m LEFT JOIN videos v ON v.module_id = m.id AND v.published = 1
     WHERE m.published = 1
     GROUP BY m.course_id`
  ).all();
  const byCourse = new Map(stats.map(s => [s.course_id, s]));
  return courses.map(c => {
    const st = byCourse.get(c.id) || {};
    return {
      ...c,
      module_count: st.module_count || 0,
      lesson_count: st.lesson_count || 0,
      total_secs: st.total_secs || 0
    };
  });
}

function publicCourse(c) {
  return {
    id: c.id, slug: c.slug, title: c.title, subtitle: c.subtitle, description: c.description,
    category: c.category, level: c.level, language: c.language,
    outcomes: (c.outcomes || '').split('\n').map(s => s.trim()).filter(Boolean),
    price: c.price, mrp: c.mrp, thumbnail_url: c.thumbnail_url, theme: c.theme,
    module_count: c.module_count, lesson_count: c.lesson_count, total_secs: c.total_secs
  };
}

async function findCourse(idOrSlug, { includeDrafts = false } = {}) {
  const isId = /^\d+$/.test(String(idOrSlug));
  const row = await db.prepare(
    `SELECT * FROM courses WHERE ${isId ? 'id' : 'slug'} = ? ${includeDrafts ? '' : 'AND published = 1'}`
  ).get(isId ? Number(idOrSlug) : String(idOrSlug));
  return row || null;
}

// Modules + videos of one course (published only). No URLs or keys.
async function courseCurriculum(courseId) {
  const modules = await db.prepare(
    'SELECT * FROM modules WHERE course_id = ? AND published = 1 ORDER BY order_index ASC, id ASC'
  ).all(courseId);
  if (!modules.length) return [];
  const videos = await db.prepare(
    `SELECT v.* FROM videos v JOIN modules m ON m.id = v.module_id
     WHERE m.course_id = ? AND v.published = 1 ORDER BY v.order_index ASC, v.id ASC`
  ).all(courseId);
  return modules.map(m => ({
    id: m.id,
    title: m.title,
    description: m.description,
    videos: videos.filter(v => v.module_id === m.id).map(v => ({
      id: v.id,
      title: v.title,
      description: v.description,
      duration_secs: v.duration_secs,
      thumbnail_url: v.thumbnail_url,
      is_preview: !!v.is_preview
    }))
  }));
}

/* ---------------- access ---------------- */
async function userAccess(userId) {
  if (!userId) return { allAccess: false, courseIds: new Set(), isAdmin: false };
  const user = await db.prepare('SELECT role, all_access FROM users WHERE id = ?').get(userId);
  const rows = await db.prepare('SELECT course_id FROM enrollments WHERE user_id = ?').all(userId);
  const isAdmin = !!(user && user.role === 'admin');
  return {
    allAccess: !!(user && (user.all_access || isAdmin)),
    courseIds: new Set(rows.map(r => r.course_id)),
    isAdmin
  };
}
function ownsCourse(access, courseId) {
  return access.allAccess || access.courseIds.has(Number(courseId));
}
function hasAnyPurchase(access) {
  return access.allAccess || access.courseIds.size > 0;
}

// Within a course, module N unlocks once every video of module N-1 is done.
// Returns a Map(moduleId -> {unlocked, completed}).
async function moduleLockState(userId, courseId, curriculum) {
  const rows = await db.prepare('SELECT video_id FROM progress WHERE user_id = ? AND completed = 1').all(userId);
  const done = new Set(rows.map(r => r.video_id));
  const state = new Map();
  let prevComplete = true;
  for (const m of curriculum) {
    const complete = m.videos.length > 0 && m.videos.every(v => done.has(v.id));
    state.set(m.id, { unlocked: prevComplete, completed: complete });
    prevComplete = complete;
  }
  return { state, done };
}

// Can this user stream this video right now?
async function canWatch(userId, video) {
  const mod = await db.prepare('SELECT course_id FROM modules WHERE id = ?').get(video.module_id);
  if (!mod) return { ok: false, reason: 'Video not found.' };
  if (video.is_preview) return { ok: true, courseId: mod.course_id, preview: true };
  const access = await userAccess(userId);
  if (!ownsCourse(access, mod.course_id)) return { ok: false, reason: 'Buy this course to watch this lesson.', needsPurchase: true, courseId: mod.course_id };
  if (access.isAdmin) return { ok: true, courseId: mod.course_id };
  const curriculum = await courseCurriculum(mod.course_id);
  const { state } = await moduleLockState(userId, mod.course_id, curriculum);
  const st = state.get(video.module_id);
  if (!st || !st.unlocked) return { ok: false, reason: 'Finish the previous module to unlock this lesson.', courseId: mod.course_id };
  return { ok: true, courseId: mod.course_id };
}

/* ---------------- pricing ---------------- */
// item: { type: 'bundle' } | { type: 'course', course }
// Returns { amount, couponCode, couponMessage }. Server-side source of truth.
async function priceFor(item, couponText) {
  let base;
  if (item.type === 'bundle') base = (await getBundle()).price;
  else base = Number(item.course.price);

  if (!couponText) return { amount: base, base, couponCode: null };
  const coupon = await db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(String(couponText).trim());
  if (!coupon) return { amount: base, base, couponCode: null, couponMessage: 'This coupon code is invalid.' };

  if (coupon.percent_off !== null && coupon.percent_off !== undefined) {
    const pct = Math.max(0, Math.min(100, Number(coupon.percent_off)));
    const amount = Math.max(1, Math.round(base * (100 - pct) / 100));
    return { amount, base, couponCode: coupon.code, couponMessage: `${pct}% off applied.` };
  }
  // Legacy fixed-price coupon from the single-program era: bundle only.
  if (item.type === 'bundle' && coupon.discount_price > 0 && coupon.discount_price < base) {
    return { amount: coupon.discount_price, base, couponCode: coupon.code, couponMessage: 'Coupon applied.' };
  }
  return { amount: base, base, couponCode: null, couponMessage: 'This coupon does not apply to this purchase.' };
}

module.exports = {
  getSettings, setSetting, getBundle,
  listCourses, publicCourse, findCourse, courseCurriculum,
  userAccess, ownsCourse, hasAnyPurchase, moduleLockState, canWatch,
  priceFor
};
