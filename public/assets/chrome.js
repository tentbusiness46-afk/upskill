/* Upskill10x — shared storefront chrome: offer strip, header, mobile menu,
   footer. Pages put <div id="chrome-top"></div> and <div id="chrome-footer"></div>
   where these should go and read the catalogue from window.CATALOG. */
(function () {
  const { esc, rupees, thumb } = window.U;
  window.CATALOG = U.api('/catalog').catch(() => ({ courses: [], bundle: { title: 'All-Access Pass', price: 2999 } }));

  const I = {
    chev: '<svg class="icon" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    search: '<svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    menu: '<svg class="icon" style="width:22px;height:22px" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    x: '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
  };

  function stripDismissed() { try { return sessionStorage.getItem('u10x_strip') === '0'; } catch (e) { return false; } }

  const top = document.getElementById('chrome-top');
  if (top) {
    top.innerHTML = `
      <div class="offer-strip" id="offerStrip" ${stripDismissed() || top.hasAttribute('data-no-offer') ? 'hidden' : ''}>
        <div class="wrap">
          <div class="offer-gift">🎁</div>
          <div class="offer-text" id="offerText">Every course, one price.</div>
          <span class="offer-timer-label" style="font-size:12px;font-weight:700">Ends in</span>
          <div class="offer-timer" id="offerTimer"></div>
          <a href="/pay?item=bundle" class="btn btn-dark btn-sm">Buy now</a>
          <button class="offer-close" id="offerClose" aria-label="Dismiss offer">${I.x}</button>
        </div>
      </div>
      <header class="site-header">
        <div class="wrap">
          <a href="/" class="brand" aria-label="Upskill10x home"><img src="/assets/logo-wordmark.png" alt="Upskill10x"></a>
          <nav class="nav-links">
            <div class="dropdown">
              <a href="/courses" class="nav-link">Courses ${I.chev}</a>
              <div class="dropdown-menu" id="ddCourses"><div class="empty" style="padding:16px">Loading…</div></div>
            </div>
            <a href="/pricing" class="nav-link">Pricing</a>
          </nav>
          <form class="search desktop" id="searchForm" role="search">
            ${I.search}<input type="search" id="searchInput" placeholder="Search for anything" aria-label="Search courses">
          </form>
          <div class="header-actions">
            <a href="/auth" class="btn btn-ghost btn-sm">Sign in</a>
            <a href="/auth?tab=register" class="btn btn-primary btn-sm">Join for free</a>
            <button class="menu-btn" id="menuBtn" aria-label="Open menu">${I.menu}</button>
          </div>
        </div>
      </header>
      <div class="mobile-menu" id="mobileMenu">
        <div class="mobile-menu-panel">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <img src="/assets/logo-wordmark.png" alt="Upskill10x" style="height:24px">
            <button class="x-btn" id="menuClose" aria-label="Close menu">${I.x}</button>
          </div>
          <form class="search" id="searchFormM" role="search">${I.search}<input type="search" id="searchInputM" placeholder="Search for anything" aria-label="Search courses"></form>
          <a class="mm-link" href="/auth">Sign in</a>
          <a class="mm-link" href="/auth?tab=register">Join for free</a>
          <a class="mm-link" href="/courses">All courses</a>
          <a class="mm-link" href="/pricing">Pricing</a>
          <div class="mm-label">Courses</div>
          <div id="mmCourses"></div>
        </div>
      </div>`;

    const strip = document.getElementById('offerStrip');
    document.getElementById('offerClose').addEventListener('click', () => {
      strip.hidden = true;
      try { sessionStorage.setItem('u10x_strip', '0'); } catch (e) {}
    });
    U.countdown([document.getElementById('offerTimer')]);

    const menu = document.getElementById('mobileMenu');
    document.getElementById('menuBtn').addEventListener('click', () => menu.classList.add('open'));
    document.getElementById('menuClose').addEventListener('click', () => menu.classList.remove('open'));
    menu.addEventListener('click', e => { if (e.target === menu) menu.classList.remove('open'); });

    const onSearch = (input) => (e) => {
      e.preventDefault();
      const q = input.value.trim();
      menu.classList.remove('open');
      if (typeof window.onSiteSearch === 'function') window.onSiteSearch(q);
      else location.href = '/courses?q=' + encodeURIComponent(q);
    };
    const si = document.getElementById('searchInput'), siM = document.getElementById('searchInputM');
    document.getElementById('searchForm').addEventListener('submit', onSearch(si));
    document.getElementById('searchFormM').addEventListener('submit', onSearch(siM));
    si.addEventListener('input', () => { if (typeof window.onSiteSearch === 'function') window.onSiteSearch(si.value.trim(), true); });

    window.CATALOG.then(({ courses, bundle }) => {
      const off = U.offPct(bundle.price, bundle.mrp);
      document.getElementById('offerText').innerHTML =
        `<b>${esc(bundle.title)}</b><span class="ot-long"> — all ${courses.length} courses for</span> <b>${rupees(bundle.price)}</b><span class="ot-long">${bundle.mrp ? `<s>${rupees(bundle.mrp)}</s>` : ''}${off ? ` · <b>${off}% off</b> today` : ''}</span>`;
      const items = courses.map(c => `
        <a class="dd-item" href="/course/${esc(c.slug)}">
          <div class="dd-thumb thumb">${thumb(c, { tag: false })}</div>
          <div><b>${esc(c.title)}</b><span>${esc(c.category || 'Course')} · ${c.lesson_count} lessons</span></div>
        </a>`).join('');
      document.getElementById('ddCourses').innerHTML = items || '<div class="empty" style="padding:16px">Courses coming soon.</div>';
      document.getElementById('mmCourses').innerHTML = items;
    });
  }

  const foot = document.getElementById('chrome-footer');
  if (foot) {
    foot.outerHTML = `
      <footer>
        <div class="wrap">
          <div class="f-grid">
            <div>
              <a href="/" class="f-logo"><img src="/assets/logo-wordmark.png" alt="Upskill10x"></a>
              <p style="max-width:320px">Practical, job-ready courses in marketing, design, video, development and data. Learn. Grow. Achieve 10x.</p>
            </div>
            <div><h4>Courses</h4><ul id="fCourses"></ul></div>
            <div><h4>Upskill10x</h4><ul>
              <li><a href="/courses">All courses</a></li>
              <li><a href="/pricing">Pricing</a></li>
              <li><a href="/#how">How it works</a></li>
              <li><a href="/#faq">FAQ</a></li>
              <li><a href="/privacy">Privacy policy</a></li>
            </ul></div>
          </div>
          <div class="f-bottom"><span>© ${new Date().getFullYear()} Upskill10x. All rights reserved.</span><span>Learn. Grow. Achieve 10x.</span></div>
        </div>
      </footer>`;
    window.CATALOG.then(({ courses }) => {
      const el = document.getElementById('fCourses');
      if (el) el.innerHTML = courses.slice(0, 6).map(c => `<li><a href="/course/${esc(c.slug)}">${esc(c.title)}</a></li>`).join('');
    });
  }

  // Scroll reveal
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .12 }) : null;
  window.observeReveal = (root = document) => root.querySelectorAll('.reveal:not(.in)').forEach(el => io ? io.observe(el) : el.classList.add('in'));
  window.observeReveal();
})();
