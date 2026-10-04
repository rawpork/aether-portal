import { describe, expect, it } from 'vitest';
import { DEV_OPERATOR_ID, devOperator, devRoleFor, isDevAuthEnabled } from '../src/dev-auth.js';
import { renderMissionControlPage } from '../src/mission-control-page.js';

const local = new URL('http://127.0.0.1:8787/');

describe('dev sign-in', () => {
	it('is on only with DEV_AUTH_BYPASS on a loopback host', () => {
		expect(isDevAuthEnabled({ DEV_AUTH_BYPASS: 'true' }, local)).toBe(true);
		expect(isDevAuthEnabled({ DEV_AUTH_BYPASS: '1' }, new URL('http://localhost:8787/'))).toBe(true);
		expect(isDevAuthEnabled({}, local)).toBe(false);
		expect(isDevAuthEnabled({ DEV_AUTH_BYPASS: 'false' }, local)).toBe(false);
		expect(isDevAuthEnabled({ DEV_AUTH_BYPASS: 'true' }, new URL('https://portal.example.com/'))).toBe(false);
	});

	it('defaults the operator to Kenneth, Lead Systems Architect', () => {
		expect(devOperator({})).toMatchObject({ preferred_name: 'Kenneth', role: 'Lead Systems Architect', tier: 'pro' });
		expect(devOperator({ DEV_OPERATOR_NAME: 'Ada', DEV_OPERATOR_ROLE: 'Tester', DEV_OPERATOR_TIER: 'free' })).toMatchObject({ preferred_name: 'Ada', role: 'Tester', tier: 'free' });
	});

	it('gives a role only to the dev operator while dev sign-in is on', () => {
		const env = { DEV_AUTH_BYPASS: 'true' };
		expect(devRoleFor(env, local, DEV_OPERATOR_ID)).toBe('Lead Systems Architect');
		expect(devRoleFor(env, local, 'user_other')).toBeNull();
		expect(devRoleFor({}, local, DEV_OPERATOR_ID)).toBeNull();
	});

	it('shows the role on the Mission Control operator card, else the tier label', () => {
		expect(renderMissionControlPage({ userName: 'Kenneth', role: 'Lead Systems Architect' })).toContain('rail-user-role">Lead Systems Architect<');
		expect(renderMissionControlPage({ tier: 'pro' })).toContain('rail-user-role">Pro operator<');
	});
});
