// Local dev sign-in: under `wrangler dev`, GET /api/auth/dev signs in a fixed operator account without Google.
// Enabled only when DEV_AUTH_BYPASS is "true" (set in .dev.vars, never as a deployed secret) AND the request is to a
// loopback host, so a stray production variable still cannot open it. See .dev.vars.example.

export const DEV_OPERATOR_ID = "user_dev_operator";
export const DEV_OPERATOR_USERNAME = "dev-operator";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isDevAuthEnabled(env, url) {
  return /^(1|true)$/i.test(String(env?.DEV_AUTH_BYPASS || "")) && LOOPBACK_HOSTS.has(url.hostname);
}

// The default local session identity; DEV_OPERATOR_NAME / DEV_OPERATOR_ROLE / DEV_OPERATOR_TIER override it.
export function devOperator(env) {
  return {
    id: DEV_OPERATOR_ID,
    username: DEV_OPERATOR_USERNAME,
    preferred_name: env?.DEV_OPERATOR_NAME || "Kenneth",
    role: env?.DEV_OPERATOR_ROLE || "Lead Systems Architect",
    tier: env?.DEV_OPERATOR_TIER === "free" ? "free" : "pro"
  };
}

// The role label for a signed-in user: the dev operator's role locally, otherwise none (the UI falls back to tier).
export function devRoleFor(env, url, userId) {
  return isDevAuthEnabled(env, url) && userId === DEV_OPERATOR_ID ? devOperator(env).role : null;
}

// Creates or refreshes the dev operator's row in the local D1 database. Returns the identity.
export async function ensureDevOperator(env) {
  const operator = devOperator(env);
  await env.DB.prepare(
    "INSERT INTO users (id, username, tier, preferred_name) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET tier = excluded.tier, preferred_name = excluded.preferred_name"
  ).bind(operator.id, operator.username, operator.tier, operator.preferred_name).run();
  return operator;
}
