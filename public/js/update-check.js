// Update notice for long-lived pages. iOS keeps home-screen apps alive and restores the last page on reopen, so a
// page can keep running an old deploy for days. When the page comes back to the foreground (and every 10 minutes),
// this compares the version it was built from (<meta name="aether-version">) with GET /api/version and, if a newer
// deploy is live, shows a bar with a Reload button. It never reloads on its own, so nothing typed is lost.

export const VERSION_ENDPOINT = '/api/version';
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;

export async function fetchLiveVersion(fetchImpl = globalThis.fetch.bind(globalThis)) {
  try {
    const response = await fetchImpl(VERSION_ENDPOINT, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export function startUpdateCheck(doc = document, options = {}) {
  const win = doc.defaultView || globalThis;
  const current = options.current || (doc.querySelector('meta[name="aether-version"]') || {}).content || '';
  const fetchImpl = options.fetch;
  const reload = options.reload || (() => win.location.reload());
  // Local dev builds report "dev"; there is nothing to compare.
  if (!current || current === 'dev') return { check: async () => false, stop() {} };

  let bar = null;
  let checking = false;

  function showBar() {
    if (bar) return;
    bar = doc.createElement('div');
    bar.className = 'aether-update-bar';
    bar.setAttribute('role', 'status');
    bar.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom, 0px));z-index:1000;display:flex;align-items:center;gap:10px;' +
      'padding:10px 12px;border:1px solid rgba(0,255,204,0.55);border-radius:8px;background:#0b1320;color:#dffdf7;font:14px system-ui,-apple-system,sans-serif;';
    const text = doc.createElement('span');
    text.textContent = 'Aether was updated.';
    text.style.flex = '1';
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload';
    button.style.cssText = 'appearance:none;height:34px;padding:0 14px;border:1px solid #00ffcc;border-radius:6px;background:#00ffcc;color:#041016;font-weight:700;font-size:14px;cursor:pointer;';
    button.addEventListener('click', () => reload());
    bar.append(text, button);
    doc.body.append(bar);
  }

  async function check() {
    if (checking || bar) return Boolean(bar);
    checking = true;
    try {
      const live = await fetchLiveVersion(fetchImpl);
      if (live && live !== current && live !== 'dev') showBar();
      return Boolean(bar);
    } finally {
      checking = false;
    }
  }

  const onVisible = () => {
    if (!doc.hidden) check();
  };
  doc.addEventListener('visibilitychange', onVisible);
  win.addEventListener('pageshow', onVisible);
  const timer = setInterval(onVisible, CHECK_INTERVAL_MS);

  return {
    check,
    stop() {
      clearInterval(timer);
      doc.removeEventListener('visibilitychange', onVisible);
      win.removeEventListener('pageshow', onVisible);
      if (bar) bar.remove();
    },
  };
}

if (typeof document !== 'undefined' && document.querySelector('meta[name="aether-version"]')) startUpdateCheck();
