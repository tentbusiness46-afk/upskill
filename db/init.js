// db/init.js
// Run on every deploy (npm run db:init). Safe to run repeatedly:
//   1. creates any missing tables
//   2. adds columns introduced by the multi-course update (idempotent)
//   3. one-time data migration from the single-course setup
//   4. bootstraps the admin account and, on an empty DB, a starter course
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./index');

// The launch catalogue. `match` decides which existing modules move into
// the course during the one-time migration (by module title).
const LAUNCH_COURSES = [
  { slug: 'seo-masterclass', title: 'SEO Masterclass', category: 'SEO', price: 499, mrp: 2999, theme: 2,
    subtitle: 'Rank on Google with keyword research, on-page, technical and local SEO.',
    description: 'Learn how search engines work and how to get pages to the top — keyword research, on-page and technical SEO, link building and local SEO, with real examples from Indian businesses.',
    outcomes: ['Find keywords people actually search for', 'Optimise pages that rank and convert', 'Fix technical SEO issues with free tools', 'Rank local businesses on Google Maps'],
    match: /\b(seo|search engine|keyword|content strategy|blog)/i },
  { slug: 'meta-ads', title: 'Meta Ads Mastery', category: 'Paid Ads', price: 699, mrp: 4999, theme: 3,
    subtitle: 'Plan, launch and scale Facebook & Instagram ads that pay back.',
    description: 'Run profitable Facebook and Instagram campaigns — Ads Manager, audiences, creatives, funnels, tracking and scaling — plus how to manage ads for clients.',
    outcomes: ['Set up Ads Manager, Pixel and conversions', 'Build audiences that convert', 'Write and design ads that get clicks', 'Read reports and scale winning campaigns'],
    match: /\b(meta|facebook|instagram|paid ads|ads|social media|funnel|google ads|sem|ppc|client|freelanc|digital marketing)/i },
  { slug: 'video-editing-pro', title: 'Video Editing Pro', category: 'Video Editing', price: 499, mrp: 3999, theme: 1,
    subtitle: 'Cuts, colour grading and motion graphics, from raw footage to publish-ready.',
    description: 'Edit like a pro — timelines, cuts, audio, colour grading, motion graphics and short-form reels that hold attention.',
    outcomes: ['Edit reels, shorts and YouTube videos', 'Colour-grade footage for a pro look', 'Add motion graphics and captions', 'Deliver client-ready exports'],
    match: /\b(video|edit|reel|premiere|after effects|motion)/i },
  { slug: 'graphic-design-essentials', title: 'Graphic Design Essentials', category: 'Design', price: 499, mrp: 3499, theme: 7,
    subtitle: 'Colour, type and branding: the principles behind work clients say yes to.',
    description: 'Design principles, Canva and Photoshop, social media creatives and full branding projects for your portfolio.',
    outcomes: ['Apply colour, type and layout principles', 'Design social posts and ad creatives', 'Build a brand identity from scratch', 'Create a portfolio clients trust'],
    match: /\b(graphic|design|canva|photoshop|illustrator|brand)/i },
  { slug: 'website-development', title: 'Website Development', category: 'Development', price: 699, mrp: 4999, theme: 0,
    subtitle: 'Build and launch fast, modern websites — HTML, CSS, JavaScript and WordPress.',
    description: 'Go from a blank page to a live website: HTML, CSS, JavaScript, responsive layouts, WordPress, hosting and domains — and how to build sites for clients.',
    outcomes: ['Build responsive pages with HTML & CSS', 'Add interactivity with JavaScript', 'Launch WordPress sites for clients', 'Connect domains and go live'],
    match: /\b(web|website|html|css|javascript|wordpress)/i },
  { slug: 'app-development', title: 'App Development', category: 'Development', price: 799, mrp: 5999, theme: 6,
    subtitle: 'Design and build Android apps — from idea to Play Store.',
    description: 'Plan, design and build real mobile apps, connect them to a backend and publish them on the Google Play Store.',
    outcomes: ['Design app screens users love', 'Build an Android app step by step', 'Connect your app to a database', 'Publish on the Google Play Store'],
    match: /\b(apps?|android|mobile|flutter|play store)\b/i },
  { slug: 'advanced-excel', title: 'Advanced Excel', category: 'Data', price: 399, mrp: 2499, theme: 5,
    subtitle: 'Formulas, pivots, dashboards and automation for real office work.',
    description: 'Master the Excel skills every office job asks for — formulas, lookups, pivot tables, charts, dashboards and time-saving automation.',
    outcomes: ['Use XLOOKUP, IF and other key formulas', 'Summarise data with pivot tables', 'Build clean dashboards', 'Automate repetitive work'],
    match: /\b(excel|spreadsheet|sheet)/i },
  { slug: 'power-bi', title: 'Power BI for Beginners', category: 'Data', price: 599, mrp: 3999, theme: 4,
    subtitle: 'Turn spreadsheets into interactive dashboards your manager will love.',
    description: 'Import and clean data, model it, write DAX and publish interactive Power BI reports.',
    outcomes: ['Import and clean data with Power Query', 'Model data and write DAX measures', 'Design interactive dashboards', 'Publish and share reports'],
    match: /\b(power ?bi|dax|dashboard)/i }
];

// [table, column, definition]
const COLUMN_MIGRATIONS = [
  ['users',   'all_access',  'INTEGER NOT NULL DEFAULT 0'],
  ['modules', 'course_id',   'INTEGER REFERENCES courses(id)'],
  ['videos',  'is_preview',  'INTEGER NOT NULL DEFAULT 0'],
  ['orders',  'item_type',   "TEXT NOT NULL DEFAULT 'bundle'"],
  ['orders',  'course_id',   'INTEGER'],
  ['coupons', 'percent_off', 'INTEGER']
];

async function columnExists(table, column) {
  const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

async function getSetting(key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(schema);
  console.log('✔ Schema applied.');

  for (const [table, column, def] of COLUMN_MIGRATIONS) {
    if (!(await columnExists(table, column))) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`).run();
      console.log(`✔ Added ${table}.${column}`);
    }
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id)').run();

  // Default admin-editable settings (only written if missing).
  const DEFAULTS = {
    bundle_title: 'All-Access Pass',
    bundle_price: process.env.BUNDLE_PRICE || 2999,
    bundle_mrp: process.env.BUNDLE_MRP || 11999,
    bundle_tagline: 'Every course on Upskill10x, including every new course we launch.'
  };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if ((await getSetting(k)) === null) await setSetting(k, v);
  }

  // --- One-time move from "one program" to "many courses" ---
  // Creates the eight launch courses. Existing modules are matched to a
  // course by their title where possible (e.g. "SEO …" -> SEO Masterclass);
  // anything that doesn't match stays "Unassigned" in Admin > Modules & Videos
  // until you move it. Every student who had already paid for the old
  // program gets the All-Access Pass (they paid for the whole thing).
  if ((await getSetting('migration_multicourse_v1')) === null) {
    const courseCount = (await db.prepare('SELECT COUNT(*) AS c FROM courses').get()).c;
    if (courseCount === 0) {
      for (let i = 0; i < LAUNCH_COURSES.length; i++) {
        const c = LAUNCH_COURSES[i];
        await db.prepare(
          `INSERT INTO courses (slug, title, subtitle, description, category, price, mrp, theme, order_index, outcomes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(c.slug, c.title, c.subtitle, c.description, c.category, c.price, c.mrp, c.theme, i, c.outcomes.join('\n'));
      }
      console.log(`✔ Created ${LAUNCH_COURSES.length} courses.`);
    }
    const courses = await db.prepare('SELECT id, slug FROM courses').all();
    const idBySlug = new Map(courses.map(c => [c.slug, c.id]));
    const modules = await db.prepare('SELECT id, title FROM modules WHERE course_id IS NULL').all();
    let matched = 0;
    for (const m of modules) {
      // Specific topics first, broad marketing words last.
      const order = ['seo-masterclass', 'video-editing-pro', 'advanced-excel', 'power-bi', 'website-development', 'app-development', 'graphic-design-essentials', 'meta-ads'];
      const hit = order.map(sl => LAUNCH_COURSES.find(c => c.slug === sl)).find(c => c.match.test(m.title));
      if (hit && idBySlug.has(hit.slug)) {
        await db.prepare('UPDATE modules SET course_id = ? WHERE id = ?').run(idBySlug.get(hit.slug), m.id);
        matched++;
      }
    }
    if (modules.length) console.log(`✔ Matched ${matched} of ${modules.length} existing module(s) to courses; the rest are "Unassigned" in the admin panel.`);
    const upgraded = await db.prepare(
      `UPDATE users SET all_access = 1 WHERE is_enrolled = 1 AND role = 'student'`
    ).run();
    if (upgraded.changes) console.log(`✔ Gave All-Access to ${upgraded.changes} previously paid student(s).`);
    await setSetting('migration_multicourse_v1', new Date().toISOString());
  }

  // --- Bootstrap admin account ---
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@upskill10x.com').toLowerCase();
  const existingAdmin = await db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change_this_immediately', 12);
    await db.prepare(
      `INSERT INTO users (name, email, phone, password_hash, role, is_enrolled, all_access, enrolled_at)
       VALUES (?, ?, NULL, ?, 'admin', 1, 1, datetime('now'))`
    ).run(process.env.ADMIN_NAME || 'Upskill10x Admin', adminEmail, hash);
    console.log(`✔ Admin account created: ${adminEmail}`);
  } else {
    console.log('• Admin account already exists, skipping.');
  }

  console.log('\nDone. You can now run: npm start');
}

run()
  .catch((err) => {
    console.error('db:init failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.client.close();
  });
