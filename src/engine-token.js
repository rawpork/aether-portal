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

export async function mintEngineToken(userId, secret, now = Date.now(), ttlSeconds = ENGINE_TOKEN_TTL_SECONDS) {
	if (!secret) throw new Error('ENGINE_JWT_SECRET is not set.');
	const iat = Math.floor(now / 1000);
	const exp = iat + ttlSeconds;
	const unsigned =
		encodeJson({ alg: 'HS256', typ: 'JWT' }) +
		'.' +
		encodeJson({ sub: 'portal:' + userId, role: 'authenticated', aud: 'authenticated', iss: 'aether-portal', iat, exp });
	const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned)));
	return { token: unsigned + '.' + base64Url(signature), expires_at: new Date(exp * 1000).toISOString() };
}
