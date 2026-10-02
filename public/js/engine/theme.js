// Light / dark theme for Mission Control, kept in step with the Aether Engine status page (UNIFIED_BRAND.md). The
// server renders data-theme on <html> from ?theme= or the aether_theme cookie; this module adopts and saves a
// ?theme= that arrived from the Engine, drives the rail's Theme toggle, and builds the rail's Engine State link,
// which carries the current theme (?theme=) and the engine token (#token=, a fragment, so it never reaches a server).
export const THEME_COOKIE = 'aether_theme';
export const THEME_STORAGE_KEY = 'aether.theme';
const THEME_COLORS = { light: '#18181B', dark: '#09090B' };

export const parseTheme = (value) => (value === 'light' || value === 'dark' ? value : null);

export function effectiveTheme(doc) {
  const set = parseTheme(doc.documentElement.getAttribute('data-theme'));
  if (set) return set;
  const win = doc.defaultView;
  return win && win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// <engine>/?theme=<theme>#token=<token>
export function engineStateUrl(baseUrl, theme, token) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/?theme=' + encodeURIComponent(theme);
  return token ? url + '#token=' + encodeURIComponent(token) : url;
}

export function setupTheme(doc, options = {}) {
  const win = doc.defaultView || globalThis;
  const root = doc.documentElement;
  const toggle = doc.getElementById('mc-theme-toggle');
  const label = doc.getElementById('mc-theme-label');
  const engineLink = doc.getElementById('mc-nav-engine');
  const getEngineBase = options.getEngineBase || (() => '');
  const getToken = options.getToken || (() => null);

  function save(theme) {
    try {
      doc.cookie = THEME_COOKIE + '=' + theme + '; Path=/; Max-Age=31536000; SameSite=Lax' + (win.location && win.location.protocol === 'https:' ? '; Secure' : '');
    } catch {
      // Cookies blocked: the toggle still works for this page.
    }
    try {
      win.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore: storage is optional.
    }
  }

  function paint() {
    const theme = effectiveTheme(doc);
    if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    if (toggle) toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
    if (engineLink) engineLink.href = engineStateUrl(getEngineBase(), theme, null);
  }

  function set(theme) {
    root.setAttribute('data-theme', theme);
    save(theme);
    paint();
  }

  // A ?theme= from the Engine's links is adopted, saved, and taken out of the address bar (the hash view stays).
  if (win.location && win.history) {
    const params = new URLSearchParams(win.location.search);
    const incoming = parseTheme(params.get('theme'));
    if (params.has('theme')) {
      params.delete('theme');
      const query = params.toString();
      win.history.replaceState(null, '', win.location.pathname + (query ? '?' + query : '') + win.location.hash);
    }
    if (incoming) set(incoming);
  }

  const onToggle = () => set(effectiveTheme(doc) === 'dark' ? 'light' : 'dark');
  if (toggle) toggle.addEventListener('click', onToggle);
  // The token is attached only at click time, so it is fresh and never sits in the DOM.
  const onEngine = () => {
    engineLink.href = engineStateUrl(getEngineBase(), effectiveTheme(doc), getToken());
  };
  if (engineLink) engineLink.addEventListener('click', onEngine);
  const media = win.matchMedia ? win.matchMedia('(prefers-color-scheme: dark)') : null;
  if (media && media.addEventListener) media.addEventListener('change', paint);
  paint();

  return {
    set,
    get: () => effectiveTheme(doc),
    destroy() {
      if (toggle) toggle.removeEventListener('click', onToggle);
      if (engineLink) engineLink.removeEventListener('click', onEngine);
      if (media && media.removeEventListener) media.removeEventListener('change', paint);
    },
  };
}
