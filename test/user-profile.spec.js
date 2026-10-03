import { describe, expect, it } from 'vitest';
import { ENGINE_TOKEN_TTL_SECONDS, mintEngineToken } from '../src/engine-token.js';
import { renderMissionControlPage } from '../src/mission-control-page.js';
import { PREFERRED_NAME_MAX_CHARS, displayNameFor, normalizePreferredName } from '../src/user-profile.js';

const claimsOf = (token) => JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.split('.')[1].length / 4) * 4, '=')));

describe('preferred name', () => {
	it('normalizes, clears and rejects names', () => {
		expect(normalizePreferredName('  Kenneth  ')).toEqual({ ok: true, value: 'Kenneth' });
		expect(normalizePreferredName('Ken   O')).toEqual({ ok: true, value: 'Ken O' });
		expect(normalizePreferredName('')).toEqual({ ok: true, value: null });
		expect(normalizePreferredName(null)).toEqual({ ok: true, value: null });
		expect(normalizePreferredName(42).ok).toBe(false);
		expect(normalizePreferredName('x'.repeat(PREFERRED_NAME_MAX_CHARS + 1)).ok).toBe(false);
		expect(normalizePreferredName('<b>Ken</b>').ok).toBe(false);
		expect(normalizePreferredName('Ken\u0007').ok).toBe(false);
	});

	it('prefers the preferred name over the username for display', () => {
		expect(displayNameFor({ username: 'klo377', preferred_name: 'Kenneth' })).toBe('Kenneth');
		expect(displayNameFor({ username: 'klo377', preferred_name: null })).toBe('klo377');
		expect(displayNameFor(null)).toBe('');
	});

	it('adds preferred_name to engine tokens only when set, keeping sub as the identity', async () => {
		const now = Date.UTC(2026, 9, 3, 12);
		const withName = claimsOf((await mintEngineToken('user_owner', 's', now, ENGINE_TOKEN_TTL_SECONDS, { preferred_name: 'Kenneth' })).token);
		expect(withName).toMatchObject({ sub: 'portal:user_owner', preferred_name: 'Kenneth' });
		const without = claimsOf((await mintEngineToken('user_owner', 's', now, ENGINE_TOKEN_TTL_SECONDS, { preferred_name: null })).token);
		expect(without.sub).toBe('portal:user_owner');
		expect('preferred_name' in without).toBe(false);
	});

	it('shows the display name in the Mission Control greeting meta and operator card', () => {
		const html = renderMissionControlPage({ userName: 'Kenneth' });
		expect(html).toContain('<meta name="aether-user" content="Kenneth">');
		expect(html).toContain('<span class="rail-user-name">Kenneth</span>');
	});
});
