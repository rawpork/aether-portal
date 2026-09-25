import { describe, it, expect } from "vitest";
import { base64UrlDecode, base64UrlEncode, buildGoogleAuthUrl, createPkcePair, isAllowedGoogleEmail, readOAuthCookie, safeNextPath, signOAuthCookie, usernameFromEmail, verifyGoogleIdToken } from "../src/google-auth.js";

const CLIENT_ID = "123.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const encode = value => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function makeSigner() {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"]
	);
	const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
	const sign = async (claims, header = { alg: "RS256", kid: "test-key", typ: "JWT" }) => {
		const input = encode(header) + "." + encode(claims);
		const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
		return input + "." + base64UrlEncode(signature);
	};
	return { jwks: [jwk], sign };
}

const validClaims = () => ({
	iss: "https://accounts.google.com",
	aud: CLIENT_ID,
	sub: "1109876543210",
	email: "Ada@Example.com",
	email_verified: true,
	iat: NOW / 1000 - 10,
	exp: NOW / 1000 + 3600
});

describe("verifyGoogleIdToken", () => {
	it("accepts a correctly signed token for this app", async () => {
		const { jwks, sign } = await makeSigner();
		const claims = await verifyGoogleIdToken(await sign(validClaims()), CLIENT_ID, { jwks, now: NOW });
		expect(claims).toMatchObject({ sub: "1109876543210", email: "Ada@Example.com" });
	});

	it("rejects wrong audience, issuer, expiry, unverified email and tampering", async () => {
		const { jwks, sign } = await makeSigner();
		const cases = {
			audience: { ...validClaims(), aud: "someone-else" },
			issuer: { ...validClaims(), iss: "https://evil.test" },
			expired: { ...validClaims(), exp: NOW / 1000 - 3600 },
			unverified: { ...validClaims(), email_verified: false }
		};
		for (const [name, claims] of Object.entries(cases)) {
			await expect(verifyGoogleIdToken(await sign(claims), CLIENT_ID, { jwks, now: NOW }), name).rejects.toThrow();
		}
		const token = await sign(validClaims());
		const [header, , signature] = token.split(".");
		const forged = header + "." + encode({ ...validClaims(), email: "attacker@example.com" }) + "." + signature;
		await expect(verifyGoogleIdToken(forged, CLIENT_ID, { jwks, now: NOW })).rejects.toThrow("signature");
		await expect(verifyGoogleIdToken(await sign(validClaims(), { alg: "none", kid: "test-key" }), CLIENT_ID, { jwks, now: NOW })).rejects.toThrow();
		await expect(verifyGoogleIdToken(await sign(validClaims(), { alg: "RS256", kid: "other" }), CLIENT_ID, { jwks, now: NOW })).rejects.toThrow("key");
		await expect(verifyGoogleIdToken("not.a.jwt", CLIENT_ID, { jwks, now: NOW })).rejects.toThrow();
	});
});

describe("Google sign-in helpers", () => {
	it("matches allowlisted addresses and whole domains, case-insensitively", () => {
		const list = "ada@example.com, @team.test";
		expect(isAllowedGoogleEmail("Ada@Example.com", list)).toBe(true);
		expect(isAllowedGoogleEmail("bob@team.test", list)).toBe(true);
		expect(isAllowedGoogleEmail("bob@example.com", list)).toBe(false);
		expect(isAllowedGoogleEmail("bob@evilteam.test", list)).toBe(false);
		expect(isAllowedGoogleEmail("ada@example.com", "")).toBe(false);
		expect(isAllowedGoogleEmail("ada@example.com", undefined)).toBe(false);
	});

	it("derives valid usernames from emails", () => {
		expect(usernameFromEmail("Ada.Lovelace+x@example.com")).toBe("ada.lovelacex");
		expect(usernameFromEmail("a@example.com")).toBe("usera");
		expect(usernameFromEmail("x".repeat(60) + "@example.com")).toHaveLength(24);
	});

	it("round-trips the signed OAuth cookie and rejects tampering or expiry", async () => {
		const cookie = await signOAuthCookie("secret", { state: "s1", verifier: "v1", next: "/share" }, NOW);
		expect(await readOAuthCookie("secret", cookie, NOW)).toMatchObject({ state: "s1", verifier: "v1", next: "/share" });
		expect(await readOAuthCookie("other-secret", cookie, NOW)).toBeNull();
		expect(await readOAuthCookie("secret", cookie.replace(/^./, "x"), NOW)).toBeNull();
		expect(await readOAuthCookie("secret", cookie, NOW + 11 * 60 * 1000)).toBeNull();
		expect(await readOAuthCookie("secret", "", NOW)).toBeNull();
	});

	it("builds a PKCE auth URL with minimal scopes", async () => {
		const { verifier, challenge } = await createPkcePair();
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		expect(challenge).toBe(base64UrlEncode(digest));
		const url = new URL(buildGoogleAuthUrl({ clientId: CLIENT_ID, redirectUri: "https://a.test/api/auth/callback", state: "st", codeChallenge: challenge }));
		expect(url.searchParams.get("scope")).toBe("openid email profile");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("state")).toBe("st");
	});

	it("keeps only same-site post-login paths", () => {
		expect(safeNextPath("/share?url=x")).toBe("/share?url=x");
		for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "", null]) {
			expect(safeNextPath(value), String(value)).toBe("/");
		}
	});

	it("base64url round-trips bytes", () => {
		const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
		expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes]);
	});
});
