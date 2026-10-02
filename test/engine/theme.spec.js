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

  it('defines the shared dark tokens for both the system setting and an explicit choice', () => {
    const html = renderMissionControlPage({});
    expect(html).toMatch(/prefers-color-scheme: dark[\s\S]*:root:not\(\[data-theme="light"\]\)/);
    expect(html).toContain(':root[data-theme="dark"]');
    for (const value of ['--canvas: #09090B', '--surface: #18181B', '--line: #27272A', '--ok-bg: #052E16', '--alert-bg: #451A03', '--off-bg: #450A0A']) {
      expect(html).toContain(value);
    }
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
