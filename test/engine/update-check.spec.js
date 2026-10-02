// Update notice: compares the page's build version with GET /api/version when the page returns to the foreground.
import { afterEach, describe, expect, it } from 'vitest';
import { fetchLiveVersion, startUpdateCheck } from '../../public/js/update-check.js';

const versionFetch = (version, status = 200) => async (url, init) => {
  versionFetch.calls.push({ url, init });
  if (status === 'offline') throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify({ version }), { status });
};
versionFetch.calls = [];

let checker;
afterEach(() => {
  checker && checker.stop();
  checker = null;
  versionFetch.calls = [];
  document.body.replaceChildren();
});

describe('update check', () => {
  it('asks the server for the live version without caching', async () => {
    expect(await fetchLiveVersion(versionFetch('v2'))).toBe('v2');
    expect(versionFetch.calls[0].url).toBe('/api/version');
    expect(versionFetch.calls[0].init.cache).toBe('no-store');
    expect(await fetchLiveVersion(versionFetch('v2', 'offline'))).toBe(null);
    expect(await fetchLiveVersion(versionFetch('v2', 500))).toBe(null);
  });

  it('shows a Reload bar when a newer deploy is live, and reloads only when tapped', async () => {
    let reloads = 0;
    checker = startUpdateCheck(document, { current: 'v1', fetch: versionFetch('v2'), reload: () => reloads++ });
    expect(await checker.check()).toBe(true);
    const bar = document.querySelector('.aether-update-bar');
    expect(bar.textContent).toBe('Aether was updated.Reload');
    expect(reloads).toBe(0);
    bar.querySelector('button').click();
    expect(reloads).toBe(1);
    // Only one bar, however often it checks.
    await checker.check();
    expect(document.querySelectorAll('.aether-update-bar')).toHaveLength(1);
  });

  it('stays quiet when the page is current, the server is unreachable, or this is a dev build', async () => {
    checker = startUpdateCheck(document, { current: 'v1', fetch: versionFetch('v1') });
    expect(await checker.check()).toBe(false);
    checker.stop();
    checker = startUpdateCheck(document, { current: 'v1', fetch: versionFetch('v2', 'offline') });
    expect(await checker.check()).toBe(false);
    checker.stop();
    checker = startUpdateCheck(document, { current: 'dev', fetch: versionFetch('v2') });
    expect(await checker.check()).toBe(false);
    expect(versionFetch.calls.filter((c) => c.url === '/api/version')).toHaveLength(2);
    expect(document.querySelector('.aether-update-bar')).toBe(null);
  });

  it('checks again when the app comes back to the foreground', async () => {
    checker = startUpdateCheck(document, { current: 'v1', fetch: versionFetch('v2') });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.aether-update-bar')).not.toBe(null);
  });
});
