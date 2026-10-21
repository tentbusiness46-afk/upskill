UPSKILL10X — LMS PROJECT
=================================================
A Node.js + Express + Turso (SQLite) course store + LMS, Udemy-style:
storefront (/ home with no prices, /courses, /pricing, /course/<slug>) -> sign up -> buy ONE course or the
All-Access Pass (every course, incl. future ones) via Razorpay -> learning
app (/lms: Home / Courses / Community / Jobs / Account) -> admin panel.
The selection-round form (PWYS) has been removed; /pwys redirects to /.

WHAT CHANGED IN THE MULTI-COURSE UPDATE
   - New tables: courses, enrollments, settings. New columns (added
     automatically by `npm run db:init`): modules.course_id, users.all_access,
     videos.is_preview, orders.item_type / course_id, coupons.percent_off.
   - First deploy migrates the old data: all existing modules become the
     course "Digital Marketing Mastery", and every student who had already
     paid gets the All-Access Pass. This runs once (tracked in settings).
   - Course price is set per course in Admin > Courses. Bundle price/name in
     Admin > Bundle & Settings (defaults ₹2,999 / ₹11,999).
   - Coupons are now % off and work on courses and the bundle. Old fixed-price
     coupons keep working, for the All-Access Pass only.
   - Tick "Free preview" on a video to let anyone watch it (course pages show
     a Preview link; works logged out).
   - Admin > Users > Access lets you grant a course or All-Access by hand.

WHERE TO START
   instructions/local-testing.txt              -> run it on your own machine
   instructions/razorpay-setup.txt              -> get Razorpay test/live keys
   instructions/deploy-to-render.txt            -> put it online for free
   instructions/video-conversion-and-upload.txt -> ffmpeg + Cloudflare R2
   instructions/apk-conversion.txt              -> wrap it as an Android APK

PROJECT LAYOUT
   server.js            entry point
   db/                  SQLite schema + init/seed script
   middleware/auth.js   JWT cookie auth
   routes/public.js     application form, register/login, coupons, payments
   routes/lms.js        modules/videos/progress/community (students only)
   routes/admin.js      admin-only APIs
   public/               all front-end HTML/CSS/JS
     index.html (home), courses.html, pricing.html, course.html,
     auth.html, pay.html                           (storefront + checkout)
     lms.html                                      (student app)
     admin.html                                    (admin dashboard)
     assets/site.css, site.js, chrome.js           (shared storefront code)
   render.yaml           optional one-click Render Blueprint config
   .env.example           copy to .env and fill in real values

DEFAULT LOGIN AFTER `npm run db:init`
   Admin panel: /admin — login with whatever ADMIN_EMAIL / ADMIN_PASSWORD
   you set in .env (change ADMIN_PASSWORD immediately after first login
   by editing the row directly, or ask me to add a "change password" UI).

PRICING
   Set in the admin panel (Courses, Bundle & Settings) — not in .env.

ADDING MORE MODULES/VIDEOS LATER
   Admin > Courses to add a course, then Admin > Modules & Videos, pick the
   course and add modules/videos.

ANDROID APP
   public/.well-known/assetlinks.json now points at the NEW app,
   package com.upskill10x.app. Before publishing, replace
   REPLACE_WITH_SHA256_OF_THE_NEW_UPSKILL10X_APP_SIGNING_KEY with the
   SHA-256 fingerprint of the new app's signing key (Play Console >
   App integrity > App signing). See instructions/apk-conversion.txt.
