// Theme sync with the Aether Engine status page (UNIFIED_BRAND.md): the server-rendered data-theme, the rail toggle,
// adopting ?theme= from the Engine's links, and the Engine State link carrying the theme and token.
import { afterEach, describe, expect, it } from 'vitest';
import { engineStateUrl, setupTheme } from '../../public/js/engine/theme.js';
import { parseTheme, renderMissionControlPage } from '../../src/mission-control-page.js';

let theme;
afterEach(() => {
  theme && theme.destroy();
  theme = null;
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.cookie = 'aether_theme=; Path=/; Max-Age=0';
  history.replaceState(null, '', '/mission-control');
});

function mountRail() {
  const html = renderMissionControlPage({ assetVersion: 'test' });
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('theme', () => {
  it('renders data-theme only for a valid choice', () => {
    expect(renderMissionControlPage({ theme: 'dark' })).toContain('<html lang="en" data-theme="dark">');
    expect(renderMissionControlPage({ theme: '"><script>' })).toContain('<html lang="en">');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('blue')).toBe('');
  });

  it('defines the shared dark tokens (the portal navy and teal, DESIGN.md) for both the system setting and an explicit choice', () => {
    const html = renderMissionControlPage({});
    expect(html).toMatch(/prefers-color-scheme: dark[\s\S]*:root:not\(\[data-theme="light"\]\)/);
    expect(html).toContain(':root[data-theme="dark"]');
    for (const value of ['--canvas: #080c14', '--surface: #0b1320', '--line: rgba(255,255,255,0.08)', '--accent: #00ffcc', '--on-accent: #041016', '--ok-bg: #052E16', '--alert-bg: #451A03', '--off-bg: #450A0A']) {
      expect(html.split(value).length - 1, value).toBe(2);
    }
    // One system: 6 / 8px corners and system fonts, and no blur anywhere (DESIGN.md).
    expect(html).toContain('--radius-s: 6px;');
    expect(html).toContain('--radius-m: 8px;');
    expect(html).toContain('--font: -apple-system');
    expect(html).not.toMatch(/backdrop-filter/);
  });

  it('toggles, saves the choice and updates the label', () => {
    mountRail();
    theme = setupTheme(document, { getEngineBase: () => 'http://localhost:3333' });
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('mc-theme-toggle').click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.cookie).toContain('aether_theme=dark');
    expect(localStorage.getItem('aether.theme')).toBe('dark');
    expect(document.getElementById('mc-theme-label').textContent).toBe('Light mode');
  });

  it('adopts ?theme= from the Engine and removes it from the address bar, keeping the view hash', () => {
    history.replaceState(null, '', '/mission-control?theme=dark#monitor');
    mountRail();
    theme = setupTheme(document, {});
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(location.search).toBe('');
    expect(location.hash).toBe('#monitor');
  });

  it('builds the Engine State link with the theme, adding the token only when clicked', () => {
    expect(engineStateUrl('https://engine.example/', 'dark', 'a.b.c')).toBe('https://engine.example/?theme=dark#token=a.b.c');
    mountRail();
    document.documentElement.setAttribute('data-theme', 'light');
    theme = setupTheme(document, { getEngineBase: () => 'https://engine.example', getToken: () => 'jwt' });
    const link = document.getElementById('mc-nav-engine');
    expect(link.getAttribute('href')).toBe('https://engine.example/?theme=light');
    link.addEventListener('click', (event) => event.preventDefault());
    link.click();
    expect(link.getAttribute('href')).toBe('https://engine.example/?theme=light#token=jwt');
  });
});

describe('Engine State link away from the engine computer', () => {
  const original = window.location.href;
  afterEach(() => window.happyDOM.setURL(original));

  it('never opens a localhost engine from a phone or the hosted site: it calls onEngineUnreachable instead', () => {
    window.happyDOM.setURL('https://aether.example.workers.dev/mission-control');
    mountRail();
    let opened = 0;
    theme = setupTheme(document, { getEngineBase: () => 'http://localhost:3333', getToken: () => 'a.b.c', onEngineUnreachable: () => opened++ });
    const link = document.getElementById('mc-nav-engine');
    expect(link.getAttribute('href')).toBe('#connect');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toBe(1);
    expect(link.getAttribute('href')).not.toContain('localhost');
  });

  it('through the portal relay, links to the engine public address with the token', () => {
    window.happyDOM.setURL('https://aether.example.workers.dev/mission-control');
    const html = renderMissionControlPage({ assetVersion: 'test', enginePublicUrl: 'https://abc.trycloudflare.com' });
    document.head.innerHTML = (html.match(/<meta name="aether-[^>]*>/g) || []).join('');
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    let opened = 0;
    theme = setupTheme(document, { getEngineBase: () => 'https://aether.example.workers.dev/api/engine/relay', getToken: () => 'a.b.c', onEngineUnreachable: () => opened++ });
    const link = document.getElementById('mc-nav-engine');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(opened).toBe(0);
    expect(link.getAttribute('href')).toMatch(/^https:\/\/abc\.trycloudflare\.com\/\?theme=(light|dark)#token=a\.b\.c$/);
    document.head.innerHTML = '';
  });

  it('still opens localhost on the engine computer itself', () => {
    window.happyDOM.setURL('http://127.0.0.1:8787/mission-control');
    mountRail();
    theme = setupTheme(document, { getEngineBase: () => 'http://localhost:3333', getToken: () => null });
    expect(document.getElementById('mc-nav-engine').getAttribute('href')).toMatch(/^http:\/\/localhost:3333\/\?theme=/);
  });
});
