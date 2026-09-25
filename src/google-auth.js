// Google sign-in: One Tap ID tokens and the OAuth 2.0 authorization-code flow with PKCE, verified with
// WebCrypto against Google's published keys. Account lookup and sessions stay in index.js.

export const GOOGLE_SCOPES = "openid email profile";
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const JWKS_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
// The signed cookie carrying state + PKCE verifier between /api/auth/google and /api/auth/callback.
export const OAUTH_COOKIE = "aether_oauth";
export const OAUTH_COOKIE_TTL_SECONDS = 10 * 60;

const encoder = new TextEncoder();
let jwksCache = null;

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text) {
  const base64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

const randomToken = (size = 32) => base64UrlEncode(crypto.getRandomValues(new Uint8Array(size)));

export async function createPkcePair() {
  const verifier = randomToken(48);
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
  return { verifier, challenge };
}

export function createOAuthState() {
  return randomToken(24);
}

export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  });
  return GOOGLE_AUTH_ENDPOINT + "?" + params.toString();
}

// Web clients must still send their secret alongside the PKCE verifier. Returns the raw ID token.
export async function exchangeGoogleCode({ code, verifier, clientId, clientSecret, redirectUri }) {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.id_token) {
    throw new Error("Google token exchange failed: " + response.status + " " + String(data?.error || ""));
  }
  return data.id_token;
}

async function loadGoogleKeys(now) {
  if (jwksCache && jwksCache.expires > now) return jwksCache.keys;
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) throw new Error("Google signing keys unavailable: " + response.status);
  const { keys } = await response.json();
  jwksCache = { keys: Array.isArray(keys) ? keys : [], expires: now + JWKS_CACHE_MS };
  return jwksCache.keys;
}

// Checks the RS256 signature, issuer, audience, expiry and a verified email. Returns the claims.
// jwks can be passed in (tests); otherwise Google's current keys are fetched and cached for an hour.
export async function verifyGoogleIdToken(token, clientId, { jwks = null, now = Date.now() } = {}) {
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token.");
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    throw new Error("Malformed ID token.");
  }
  if (header?.alg !== "RS256" || !header.kid) throw new Error("Unexpected ID token algorithm.");

  const keys = jwks || await loadGoogleKeys(now);
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) throw new Error("Unknown ID token signing key.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signatureOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), encoder.encode(parts[0] + "." + parts[1]));
  if (!signatureOk) throw new Error("Bad ID token signature.");

  const seconds = Math.floor(now / 1000);
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error("Unexpected ID token issuer.");
  if (claims.aud !== clientId) throw new Error("ID token was issued for another app.");
  if (!(Number(claims.exp) + CLOCK_SKEW_SECONDS > seconds)) throw new Error("ID token has expired.");
  if (Number(claims.iat) - CLOCK_SKEW_SECONDS > seconds) throw new Error("ID token is not valid yet.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ID token has no subject.");
  if (!claims.email || claims.email_verified !== true) throw new Error("Google did not confirm this email address.");
  return claims;
}

// GOOGLE_ALLOWED_EMAILS: comma/space separated addresses, or "@example.com" for a whole domain.
export function isAllowedGoogleEmail(email, allowList) {
  const address = String(email || "").trim().toLowerCase();
  if (!address.includes("@")) return false;
  const entries = String(allowList || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  return entries.some(entry => entry.startsWith("@") ? address.endsWith(entry) : address === entry);
}

// Usernames are 3-32 of [a-z0-9_.-]; taken ones get a numeric suffix from the caller.
export function usernameFromEmail(email) {
  const local = String(email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9_.-]+/g, "").slice(0, 24);
  return local.length >= 3 ? local : ("user" + local).slice(0, 24).padEnd(3, "0");
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

export async function signOAuthCookie(secret, payload, now = Date.now()) {
  const body = base64UrlEncode(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + OAUTH_COOKIE_TTL_SECONDS })));
  return body + "." + await hmac(secret, body);
}

export async function readOAuthCookie(secret, value, now = Date.now()) {
  const [body, signature] = String(value || "").split(".");
  if (!body || !signature || !secret) return null;
  const expected = await hmac(secret, body);
  // Constant-time compare of the two base64url strings.
  if (expected.length !== signature.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
    return Number(payload.exp) * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

// Only same-site relative paths survive as a post-login destination.
export function safeNextPath(value) {
  const path = String(value || "");
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path.slice(0, 2000) : "/";
}
