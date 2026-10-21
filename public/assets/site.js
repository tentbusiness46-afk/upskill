/* Upskill10x — small helpers shared by every page (storefront + app). */
(function () {
  const U = {};

  U.esc = (str = '') => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  U.rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  U.offPct = (price, mrp) => (mrp && mrp > price) ? Math.round((1 - price / mrp) * 100) : 0;

  U.duration = (secs) => {
    secs = Number(secs) || 0;
    if (!secs) return '';
    const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m} min`;
  };
  U.clock = (secs) => {
    secs = Number(secs) || 0;
    if (!secs) return '';
    const m = Math.floor(secs / 60), s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  U.initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || 'U';

  U.api = async (path, opts = {}) => {
    const res = await fetch('/api' + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || data.message || 'Something went wrong.');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  /* Generated course thumbnails: a gradient preset + an icon picked from
     the category/title, so a course looks finished before it has artwork.
     If the admin sets thumbnail_url, that image is used instead. */
  U.THEMES = [
    ['#00419e', '#1a6fe0'], ['#002c6b', '#0056d2'], ['#ea580c', '#fb923c'], ['#0056d2', '#f97316'],
    ['#1a6fe0', '#5b96ea'], ['#0f766e', '#14b8a6'], ['#002c6b', '#5b96ea'], ['#c2410c', '#0056d2']
  ];
  const ICONS = {
    marketing: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3V9Z"/>',
    seo: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5M11 8.5v5"/>',
    ads: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    design: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.6-9-7.6Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    data: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
    app: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    writing: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    social: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 13.2 7.6 4.1M15.8 6.7l-7.6 4.1"/>',
    book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1-2-1.5Z"/><path d="M8 7h8M8 11h6"/>'
  };
  U.iconFor = (course) => {
    const t = ((course.category || '') + ' ' + (course.title || '')).toLowerCase();
    if (/video|edit|reel|premiere|motion/.test(t)) return ICONS.video;
    if (/seo|search/.test(t)) return ICONS.seo;
    if (/ads|meta|google|ppc|sem|paid/.test(t)) return ICONS.ads;
    if (/design|graphic|canva|photoshop|ui|ux/.test(t)) return ICONS.design;
    if (/power ?bi|dashboard|analytics/.test(t)) return ICONS.chart;
    if (/excel|data|sheet/.test(t)) return ICONS.data;
    if (/web|code|program|develop/.test(t)) return ICONS.code;
    if (/app|mobile|android/.test(t)) return ICONS.app;
    if (/copy|writ|content/.test(t)) return ICONS.writing;
    if (/social|instagram/.test(t)) return ICONS.social;
    if (/market/.test(t)) return ICONS.marketing;
    return ICONS.book;
  };
  U.gradient = (course) => {
    const [a, b] = U.THEMES[(Number(course.theme) || 0) % U.THEMES.length];
    return `linear-gradient(140deg, ${a}, ${b})`;
  };
  // Returns inner HTML for a .thumb box.
  U.thumb = (course, { tag = true } = {}) => {
    if (course.thumbnail_url) {
      return `<img src="${U.esc(course.thumbnail_url)}" alt="" loading="lazy">${tag && course.category ? `<span class="thumb-tag">${U.esc(course.category)}</span>` : ''}`;
    }
    return `<div class="thumb-art" style="background:${U.gradient(course)}">
        <span class="thumb-o1"></span><span class="thumb-o2"></span>
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${U.iconFor(course)}</svg>
      </div>${tag && course.category ? `<span class="thumb-tag">${U.esc(course.category)}</span>` : ''}`;
  };

  U.isApp = () => !!((window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    || new URLSearchParams(location.search).get('forceApp') === '1');

  // Midnight countdown for the offer strip, IST-agnostic (user's local midnight).
  U.countdown = (els) => {
    const pad = n => String(n).padStart(2, '0');
    const tick = () => {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const d = Math.max(0, end - now);
      const h = Math.floor(d / 3600000), m = Math.floor(d % 3600000 / 60000), s = Math.floor(d % 60000 / 1000);
      els.forEach(el => { el.innerHTML = `<b>${pad(h)}</b>:<b>${pad(m)}</b>:<b>${pad(s)}</b>`; });
    };
    tick(); setInterval(tick, 1000);
  };

  // Attach an HLS stream to a <video>. Returns a destroy() function.
  U.playHls = (videoEl, url) => {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      return () => hls.destroy();
    }
    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) videoEl.src = url;
    return () => { videoEl.removeAttribute('src'); videoEl.load(); };
  };

  window.U = U;
})();
