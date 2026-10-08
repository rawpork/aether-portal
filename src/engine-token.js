// Engine tokens for Mission Control: a short-lived HS256 JWT for the signed-in portal user, accepted by the local
// Aether_Engine (src/auth.ts verifies HS256 + sub + exp). Signed with ENGINE_JWT_SECRET, which must equal the
// engine's SUPABASE_JWT_SECRET, so the browser never needs a pasted key.

export const ENGINE_TOKEN_TTL_SECONDS = 3600;

const encoder = new TextEncoder();

function base64Url(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const encodeJson = (value) => base64Url(encoder.encode(JSON.stringify(value)));

// `profile.preferred_name` (optional) is added as a display-label claim; `sub` stays the identity.
export async function mintEngineToken(userId, secret, now = Date.now(), ttlSeconds = ENGINE_TOKEN_TTL_SECONDS, profile = {}) {
	if (!secret) throw new Error('ENGINE_JWT_SECRET is not set.');
	const iat = Math.floor(now / 1000);
	const exp = iat + ttlSeconds;
	const unsigned =
		encodeJson({ alg: 'HS256', typ: 'JWT' }) +
		'.' +
		encodeJson({
			sub: 'portal:' + userId,
			role: 'authenticated',
			aud: 'authenticated',
			iss: 'aether-portal',
			iat,
			exp,
			...(profile.preferred_name ? { preferred_name: String(profile.preferred_name) } : {})
		});
	const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned)));
	return { token: unsigned + '.' + base64Url(signature), expires_at: new Date(exp * 1000).toISOString() };
}

// ---- engine:push tokens (Phase 10 realtime; ENGINE_REALTIME_CONTRACT.md) ----------------------------------------------
// The engine opens its outbound WebSocket to /api/engine/connect with one of these. It is its own audience and scope, so it
// is useless anywhere else, and the portal's normal engine tokens (aud "authenticated", no scope) are refused on that route.

export const ENGINE_PUSH_SCOPE = 'engine:push';
export const ENGINE_PUSH_AUDIENCE = 'aether-portal-realtime';
export const ENGINE_PUSH_MAX_TTL_SECONDS = 300;

// Mints the token the engine sends. The engine mints its own from the shared secret; this exists for tests and as the reference.
export async function mintEnginePushToken(userId, secret, now = Date.now(), ttlSeconds = ENGINE_PUSH_MAX_TTL_SECONDS) {
	if (!secret) throw new Error('ENGINE_JWT_SECRET is not set.');
	const iat = Math.floor(now / 1000);
	const unsigned =
		encodeJson({ alg: 'HS256', typ: 'JWT' }) +
		'.' +
		encodeJson({ sub: 'portal:' + userId, iss: 'aether-portal', aud: ENGINE_PUSH_AUDIENCE, scope: ENGINE_PUSH_SCOPE, iat, exp: iat + ttlSeconds });
	const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return unsigned + '.' + base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned))));
}

function base64UrlBytes(text) {
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Returns { userId } for a valid engine:push token, or null. Checks signature (HS256, constant-time via verify), algorithm,
// issuer, audience, exactly the engine:push scope, a lifetime of at most five minutes, and expiry.
export async function verifyEnginePushToken(token, secret, now = Date.now()) {
	if (!token || !secret) return null;
	const parts = String(token).split('.');
	if (parts.length !== 3 || parts.some((part) => !part)) return null;
	try {
		const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
		if (header.alg !== 'HS256') return null;
		const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
		if (!(await crypto.subtle.verify('HMAC', key, base64UrlBytes(parts[2]), encoder.encode(parts[0] + '.' + parts[1])))) return null;
		const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
		if (claims.iss !== 'aether-portal' || claims.aud !== ENGINE_PUSH_AUDIENCE || claims.scope !== ENGINE_PUSH_SCOPE) return null;
		if (typeof claims.sub !== 'string' || !claims.sub.startsWith('portal:') || claims.sub.length <= 'portal:'.length) return null;
		if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return null;
		if (claims.exp - claims.iat > ENGINE_PUSH_MAX_TTL_SECONDS || claims.exp * 1000 <= now) return null;
		return { userId: claims.sub.slice('portal:'.length) };
	} catch {
		return null;
	}
}
