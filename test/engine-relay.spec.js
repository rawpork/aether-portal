import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ENGINE_RELAY_PREFIX, enginePublicUrl, relayTarget, relayToEngine } from "../src/engine-relay.js";

const claims = (token) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.split(".")[1].length / 4) * 4, "=")));

function upstream(status = 200, body = { ok: true }, headers = { "content-type": "application/json" }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: Object.fromEntries(init.headers), body: init.body ? new TextDecoder().decode(init.body) : undefined, redirect: init.redirect });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { calls, fetchImpl };
}

const env = { ENGINE_PUBLIC_URL: "https://engine.example.trycloudflare.com/", ENGINE_JWT_SECRET: "s3cret" };
const user = { id: "user_dev_operator" };
const req = (path, init = {}) => new Request("https://portal.example" + path, init);

describe("engine relay", () => {
  it("only accepts an https public address (or loopback http for local testing)", () => {
    expect(enginePublicUrl(env)).toBe("https://engine.example.trycloudflare.com");
    expect(enginePublicUrl({ ENGINE_PUBLIC_URL: "http://127.0.0.1:3333" })).toBe("http://127.0.0.1:3333");
    expect(enginePublicUrl({ ENGINE_PUBLIC_URL: "http://engine.example.com" })).toBeNull();
    expect(enginePublicUrl({ ENGINE_PUBLIC_URL: "https://u:p@engine.example.com" })).toBeNull();
    expect(enginePublicUrl({ ENGINE_PUBLIC_URL: "not a url" })).toBeNull();
    expect(enginePublicUrl({})).toBeNull();
  });

  it("relays the engine JSON API and /health only", () => {
    expect(relayTarget(ENGINE_RELAY_PREFIX + "/api/workflows")).toBe("/api/workflows");
    expect(relayTarget(ENGINE_RELAY_PREFIX + "/health")).toBe("/health");
    for (const path of [ENGINE_RELAY_PREFIX, ENGINE_RELAY_PREFIX + "/", ENGINE_RELAY_PREFIX + "/api/voice/stream", ENGINE_RELAY_PREFIX + "/admin", "/api/engine/token", "/api/engine/relayx/api/a"]) {
      expect(relayTarget(path), path).toBeNull();
    }
  });

  it("forwards method, path, query and body with an engine token minted for the portal user", async () => {
    const { calls, fetchImpl } = upstream(201, { workflow: { workflow_id: "wf_1" } });
    const request = req(ENGINE_RELAY_PREFIX + "/api/workflows?limit=5", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer from-the-browser", Cookie: "aether_session=abc" },
      body: JSON.stringify({ goal: "ship it" }),
    });
    const res = await relayToEngine(request, env, new URL(request.url), user, { fetchImpl, profile: { preferred_name: "Kenneth" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ workflow: { workflow_id: "wf_1" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://engine.example.trycloudflare.com/api/workflows?limit=5");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe('{"goal":"ship it"}');
    expect(calls[0].redirect).toBe("manual");
    expect(calls[0].headers.cookie).toBeUndefined();
    const sent = calls[0].headers.authorization.replace("Bearer ", "");
    expect(sent).not.toBe("from-the-browser");
    expect(claims(sent)).toMatchObject({ sub: "portal:user_dev_operator", preferred_name: "Kenneth", iss: "aether-portal" });
    expect(claims(sent).exp - claims(sent).iat).toBe(300);
  });

  it("explains a missing configuration, an unreachable engine and a redirect", async () => {
    const r1 = await relayToEngine(req(ENGINE_RELAY_PREFIX + "/health"), {}, new URL("https://portal.example" + ENGINE_RELAY_PREFIX + "/health"), user, { fetchImpl: upstream().fetchImpl });
    expect(r1.status).toBe(404);
    expect(await r1.json()).toMatchObject({ configured: false });
    const down = async () => { throw new Error("connection refused"); };
    const r2 = await relayToEngine(req(ENGINE_RELAY_PREFIX + "/health"), env, new URL("https://portal.example" + ENGINE_RELAY_PREFIX + "/health"), user, { fetchImpl: down });
    expect(r2.status).toBe(502);
    expect((await r2.json()).error).toMatch(/unreachable \(connection refused\)/);
    const r3 = await relayToEngine(req(ENGINE_RELAY_PREFIX + "/api/x"), env, new URL("https://portal.example" + ENGINE_RELAY_PREFIX + "/api/x"), user, { fetchImpl: upstream(302, "", { location: "https://elsewhere" }).fetchImpl });
    expect(r3.status).toBe(502);
    const ws = req(ENGINE_RELAY_PREFIX + "/api/tasks", { headers: { Upgrade: "websocket" } });
    expect((await relayToEngine(ws, env, new URL(ws.url), user, { fetchImpl: upstream().fetchImpl })).status).toBe(400);
  });

  it("passes engine errors through unchanged", async () => {
    const { fetchImpl } = upstream(409, { error: "The workflow changed since you loaded it." });
    const request = req(ENGINE_RELAY_PREFIX + "/api/workflows/wf_1/graph", { method: "POST", body: "{}" });
    const res = await relayToEngine(request, env, new URL(request.url), user, { fetchImpl });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed/);
  });

  it("requires a portal session on the Worker route", async () => {
    const res = await SELF.fetch("https://portal.example" + ENGINE_RELAY_PREFIX + "/api/workflows");
    expect(res.status).toBe(401);
  });
});
