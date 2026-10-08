import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ENGINE_TOKEN_TTL_SECONDS, mintEngineToken } from '../src/engine-token.js';
import { renderMissionControlPage } from '../src/mission-control-page.js';

const fromB64url = (part) => atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));

describe('engine token minting', () => {
	it('mints an HS256 JWT the engine can verify with the shared secret', async () => {
		const now = Date.UTC(2026, 9, 1, 12);
		const { token, expires_at } = await mintEngineToken('user_owner', 'engine-secret', now);
		const [header, payload, signature] = token.split('.');
		expect(JSON.parse(fromB64url(header))).toEqual({ alg: 'HS256', typ: 'JWT' });
		const claims = JSON.parse(fromB64url(payload));
		expect(claims).toMatchObject({ sub: 'portal:user_owner', role: 'authenticated', iss: 'aether-portal', iat: now / 1000, exp: now / 1000 + ENGINE_TOKEN_TTL_SECONDS });
		expect(expires_at).toBe(new Date(now + ENGINE_TOKEN_TTL_SECONDS * 1000).toISOString());

		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('engine-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
		const sig = Uint8Array.from(fromB64url(signature), (c) => c.charCodeAt(0));
		expect(await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(header + '.' + payload))).toBe(true);
		const wrong = await crypto.subtle.importKey('raw', new TextEncoder().encode('other'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
		expect(await crypto.subtle.verify('HMAC', wrong, sig, new TextEncoder().encode(header + '.' + payload))).toBe(false);
	});

	it('refuses to mint without a secret', async () => {
		await expect(mintEngineToken('u', '')).rejects.toThrow('ENGINE_JWT_SECRET');
	});
});

describe('Mission Control routes', () => {
	it('sends signed-out visitors to sign in and back', async () => {
		const response = await SELF.fetch('http://example.com/mission-control', { redirect: 'manual' });
		expect(response.status).toBe(303);
		const location = new URL(response.headers.get('Location'));
		expect(location.pathname).toBe('/');
		expect(location.searchParams.get('next')).toBe('/mission-control');
		expect((await SELF.fetch('http://example.com/mission-control', { method: 'POST' })).status).toBe(405);
	});

	it('only hands engine tokens to signed-in users', async () => {
		expect((await SELF.fetch('http://example.com/api/engine/token')).status).toBe(401);
		expect((await SELF.fetch('http://example.com/api/engine/token', { method: 'POST' })).status).toBe(405);
	});

	it('keeps engine controls out of the main portal header, linking to Mission Control instead', async () => {
		const html = await (await SELF.fetch('http://example.com/')).text();
		expect(html).toContain('id="mission-control-tab"');
		expect(html).toContain('href="/mission-control"');
		// The same link also sits in the top bar's second slot, mirroring Space's link in Mission Control's header (WCAG 3.2.3).
		expect(html).toMatch(/<nav class="shell-switch" aria-label="Aether"><a class="shell-item" data-surface="space" href="\/" aria-current="page"[^>]*>[\s\S]*?<a class="shell-item" data-surface="mission-control" href="\/mission-control" aria-label="Mission Control" aria-keyshortcuts="Alt\+M"/);
		expect(html).toContain('data-shell-surface="space"');
		for (const gone of ['engine-bar', 'brain-dock', 'breaker-bar.js', 'engine-badge', 'aether.engine.jwt']) {
			expect(html, gone).not.toContain(gone);
		}
	});

	it('renders the workspace with the breaker in the header and one module script', () => {
		const html = renderMissionControlPage({ assetVersion: 'v1' });
		const header = /<header class="mc-top">([\s\S]*?)<\/header>/.exec(html)[1];
		expect(header).toContain('id="mc-breaker"');
		for (const id of ['mc-monitor', 'mc-elaron', 'mc-connection']) expect(html, id).toContain(`id="${id}"`);
		// Three module scripts: the realtime boot (inert unless the page's aether-realtime meta is on), the workspace and the update check.
		expect(html.match(/<script/g)).toHaveLength(3);
		expect(html).toContain('src="/js/realtime-boot.js?v=v1"');
		expect(html).toContain('src="/js/engine/mission-control.js?v=v1"');
		expect(html).toContain('src="/js/update-check.js?v=v1"');
		expect(html).toContain('<meta name="aether-version" content="v1">');
	});

	it('passes the tier and only an https upgrade URL to the page, escaped', () => {
		const html = renderMissionControlPage({ tier: 'pro"><script>', upgradeUrl: 'https://billing.example/up?a=1&b=2' });
		expect(html).toContain('<meta name="aether-tier" content="pro&quot;&gt;&lt;script&gt;">');
		expect(html).toContain('<meta name="aether-upgrade-url" content="https://billing.example/up?a=1&amp;b=2">');
		expect(renderMissionControlPage({ upgradeUrl: 'javascript:alert(1)' })).toContain('<meta name="aether-upgrade-url" content="">');
		expect(renderMissionControlPage()).toContain('<meta name="aether-tier" content="free">');
		for (const id of ['mc-nav-overview', 'mc-nav-monitor', 'mc-nav-blueprints', 'mc-nav-new', 'mc-nav-studio', 'mc-drawer', 'mc-elaron', 'mc-nav-connect', 'mc-workforce', 'mc-view-blueprints', 'mc-blueprints', 'mc-view-connect', 'mc-connect']) expect(html, id).toContain(`id="${id}"`);
		// The rail: six core items (Mission Control, Space, New, Projects, Runs, Studio) and Settings at the bottom; Elarion is a drawer.
		const rail = /<aside[^>]*id="mc-rail"[\s\S]*?<\/aside>/.exec(html)[0];
		expect([...rail.matchAll(/id="(mc-nav-[a-z]+)"/g)].map((m) => m[1])).toEqual(['mc-nav-overview', 'mc-nav-space', 'mc-nav-new', 'mc-nav-blueprints', 'mc-nav-monitor', 'mc-nav-studio', 'mc-nav-connect']);
		expect(html).not.toContain('id="mc-view-elaron"');
	});

	it('greets the signed-in user by name, escaped, with their initials in the rail', () => {
		const html = renderMissionControlPage({ userName: 'alex.morgan"><b>' });
		expect(html).toContain('<meta name="aether-user" content="Alex.morgan&quot;&gt;&lt;b&gt;">');
		expect(html).not.toContain('"><b>');
		expect(renderMissionControlPage({ userName: 'alex.morgan' })).toContain('<span class="rail-avatar" aria-hidden="true">AM</span>');
		expect(renderMissionControlPage()).toContain('<span class="rail-user-name">Operator</span>');
	});

	it('only serves the AEPS skills registry to signed-in users', async () => {
		expect((await SELF.fetch('http://example.com/api/skills/aeps')).status).toBe(401);
		expect((await SELF.fetch('http://example.com/api/skills/aeps', { method: 'POST' })).status).toBe(405);
	});

	it('keeps the header clear of the iPhone status bar and honors the hidden attribute', () => {
		const html = renderMissionControlPage();
		// Matches the main portal page, which iOS keeps below the status bar: no viewport-fit=cover.
		expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(html).not.toContain('viewport-fit=cover');
		expect(html).toMatch(/\.mc-top \{[^}]*padding: calc\(\d+px \+ env\(safe-area-inset-top/);
		expect(html).toContain('[hidden] { display: none !important; }');
	});

	it('serves the deployed version publicly, and both pages carry it for the update check', async () => {
		const response = await SELF.fetch('http://example.com/api/version');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(typeof (await response.json()).version).toBe('string');
		expect((await SELF.fetch('http://example.com/api/version', { method: 'POST' })).status).toBe(405);
		const home = await (await SELF.fetch('http://example.com/')).text();
		expect(home).toMatch(/<meta name="aether-version" content="[^"]+">/);
		expect(home).toMatch(/<script type="module" src="\/js\/update-check\.js\?v=[^"]+"><\/script>/);
	});

	it('gives outcome cards an Open in Mission Control link', async () => {
		const html = await (await SELF.fetch('http://example.com/')).text();
		expect(html).toContain('id="outcome-mission-control"');
	});
});

describe('missing static files', () => {
	it('answer 404 as plain text instead of the portal page, so a missing module is not reported as a MIME-type error', async () => {
		for (const path of ['/js/engine/status_pill.js', '/js/nope.js', '/vendor/missing.min.js', '/styles/old.css', '/js/engine/x.js.map']) {
			const res = await SELF.fetch('http://example.com' + path);
			expect(res.status, path).toBe(404);
			expect(res.headers.get('content-type'), path).toContain('text/plain');
			expect(await res.text(), path).toContain('Not found: ' + path);
		}
	});
});

describe('moving between the two surfaces', () => {
	const switchOf = (html) => /<nav class="shell-switch"[\s\S]*?<\/nav>/.exec(html)[0];

	it('keeps the two-item switch in Space\'s header; Mission Control reaches Space through the rail\'s brand', async () => {
		const space = await (await SELF.fetch('http://example.com/')).text();
		const mission = renderMissionControlPage({ assetVersion: 'v1' });
		// Space's header still has the switch, with its own page marked current.
		expect(switchOf(space)).toMatch(/data-surface="space"[^>]*aria-current="page"/);
		expect(switchOf(space).match(/aria-current="page"/g)).toHaveLength(1);
		// Mission Control's header does not: one row, the title (the menu button) and the status pill.
		const header = /<header class="mc-top">[\s\S]*?<\/header>/.exec(mission)[0];
		expect(header).not.toContain('shell-switch');
		expect(header).not.toContain('shell-item');
		expect(header).not.toContain('mc-new-agent');
		expect(header).toContain('id="mc-menu-toggle"');
		expect(header).toContain('data-status="pill"');
		// The way to Space is the rail's brand, with the same shortcut and the same destination as the old switch item.
		expect(mission).toMatch(/<a class="rail-brand" href="\/" data-surface="space" title="Space: the 3D graph \(Alt\+S\)" aria-label="Aether Space \(Alt\+S\)" aria-keyshortcuts="Alt\+S">/);
		// Each page marks its own surface for the shortcuts, and both keep the page cross-fade.
		expect(space).toContain('data-shell-surface="space"');
		expect(mission).toContain('data-shell-surface="mission-control"');
		for (const html of [space, mission]) {
			expect(html).not.toContain('surface-link');
			expect(html).not.toContain('topbar-mission-control');
			expect(html).toContain('@view-transition { navigation: auto; }');
			expect(html).toMatch(/prefers-reduced-motion: reduce\) \{\s*::view-transition-group/);
		}
	});

	it('styles the title as the menu button, with a 44px touch target, and no bordered square', () => {
		const html = renderMissionControlPage({ assetVersion: 'v1' });
		expect(html).toMatch(/\.mc-menu-button \{[^}]*min-height: 44px;/);
		expect(html).not.toContain('.menu-toggle {');
		// On a phone the title wraps to two lines inside the button instead of clipping.
		expect(html).toMatch(/\.mc-menu-text \{ white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2;/);
	});
});

describe('text fields on touch screens', () => {
	it('stay at 16px so iOS Safari does not zoom the page in (and leave it zoomed, with the header and right edge off-screen)', () => {
		const html = renderMissionControlPage({ assetVersion: 'v1' });
		const rule = /@media \(max-width: 900px\), \(pointer: coarse\) \{\s*(input:not[^{]*\{[^}]*\})/.exec(html);
		expect(rule, 'the touch-screen font rule is in the page').not.toBeNull();
		expect(rule[1]).toContain('font-size: 16px !important');
		expect(rule[1]).toContain('textarea');
		expect(rule[1]).toContain('select');
		// Check boxes, radios, sliders and file pickers are not text fields and keep their own size.
		for (const type of ['checkbox', 'radio', 'range', 'file']) expect(rule[1]).toContain(':not([type="' + type + '"])');
	});

	it('does not disable pinch-zoom, which people with low vision rely on', () => {
		const html = renderMissionControlPage({ assetVersion: 'v1' });
		const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)[1];
		expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale/);
	});
});

describe('the + Skill ingest form styles', () => {
	const html = renderMissionControlPage({ assetVersion: 'v1' });
	// Every rule for the selector, joined (a selector can have a base rule and a later one).
	const rule = (selector) => {
		const found = [];
		for (let start = html.indexOf(selector + ' {'); start >= 0; start = html.indexOf(selector + ' {', start + 1)) found.push(html.slice(start, html.indexOf('}', start) + 1));
		return found.join(' ');
	};

	it('box every control to its column so nothing spills sideways', () => {
		const controls = rule('.dc-ingest input, .dc-ingest select, .dc-ingest textarea');
		expect(controls).toContain('box-sizing: border-box');
		expect(controls).toContain('width: 100%');
		expect(controls).toContain('max-width: 100%');
		expect(controls).toContain('min-width: 0');
		expect(rule('.dc-modal')).toContain('max-width: 100%');
		expect(rule('.dc-field')).toContain('min-width: 0');
		expect(rule('.dc-ingest')).toContain('max-width: 100%');
	});

	it('draw dropdowns in the page theme: no native arrow or white option list, a themed chevron, a border, rounded corners', () => {
		const select = rule('.dc-ingest select');
		expect(select).toContain('appearance: none');
		expect(select).toContain('-webkit-appearance: none');
		expect(select).toContain('background-color: var(--surface-soft)');
		expect(select).toContain('border: 1px solid var(--line-strong)');
		expect(select).toContain('border-radius: var(--radius-m)');
		expect(select).toContain('color: var(--text)');
		// The options carry explicit colours, or mobile browsers show them white.
		const option = rule('.dc-ingest select option');
		expect(option).toContain('background-color: var(--surface)');
		expect(option).toContain('color: var(--text)');
		// The chevron is drawn by the box around the select, in a theme colour, and never takes the tap.
		const chevron = rule('.dc-select::after');
		expect(chevron).toContain('border-right: 2px solid var(--muted)');
		expect(chevron).toContain('pointer-events: none');
		// Room for the chevron, and a touch target of at least 44px.
		expect(select).toMatch(/padding: 10px 44px 10px 14px/);
		expect(Number(/min-height: (\d+)px/.exec(select)[1])).toBeGreaterThanOrEqual(44);
		// The page's colour scheme follows its theme, so the popup list does too.
		expect(html).toMatch(/color-scheme: dark/);
		expect(html).toMatch(/color-scheme: light/);
	});

	it('stack the two small fields on a narrow screen, and keep the inputs at 16px on touch screens', () => {
		expect(html).toMatch(/@media \(max-width: 480px\) \{ \.dc-row \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
		expect(html).toMatch(/@media \(max-width: 900px\), \(pointer: coarse\) \{ \.dc-ingest input, \.dc-ingest select, \.dc-ingest textarea \{ font-size: 16px !important; \} \}/);
	});
});
