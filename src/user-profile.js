// Preferred name: the display name the Portal UI uses for the signed-in user (portal header, Mission Control greeting
// and operator card). Stored per account in users.preferred_name (migration 0016) and set with PATCH /api/settings.
// The username stays the account identity; the name is display metadata only. It also rides along in engine tokens
// (claim preferred_name) so the Aether Engine can label its logs and Miserly telemetry next to the raw user id.

export const PREFERRED_NAME_MAX_CHARS = 40;

// "" or null clears the name. Control characters and angle brackets are refused rather than silently stripped.
export function normalizePreferredName(value) {
	if (value === null) return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: 'preferred_name must be a string.' };
	const name = value.trim().replace(/\s+/g, ' ');
	if (!name) return { ok: true, value: null };
	if (name.length > PREFERRED_NAME_MAX_CHARS) return { ok: false, error: 'preferred_name can be at most ' + PREFERRED_NAME_MAX_CHARS + ' characters.' };
	if (/[\u0000-\u001f\u007f<>]/.test(name)) return { ok: false, error: 'preferred_name cannot contain control characters or < >.' };
	return { ok: true, value: name };
}

export const displayNameFor = (account) => (account && (account.preferred_name || account.username)) || '';

// Account row for page rendering. Falls back to the pre-0016 columns while the migration is not applied yet.
export async function loadAccount(env, userId) {
	try {
		return await env.DB.prepare('SELECT tier, username, preferred_name FROM users WHERE id = ?').bind(userId).first();
	} catch {
		return env.DB.prepare('SELECT tier, username FROM users WHERE id = ?').bind(userId).first().catch(() => null);
	}
}

export async function loadPreferredName(env, userId) {
	try {
		const row = await env.DB.prepare('SELECT preferred_name FROM users WHERE id = ?').bind(userId).first();
		return row?.preferred_name || null;
	} catch {
		return null;
	}
}
