import { cleanLinkUrl, fallbackLinkTitle, fetchLinkMetadata, getYouTubeVideoId } from "./metadata.js";
import { MINER_BATCH_SIZE, MINER_CONTEXT_SIZE, buildMinerPrompt, parseMinerResponse } from "./miner.js";
import { GROUP_NAME_MAX, buildConceptLinks, ensureGroup, listGroups, loadNodeTags, normalizeGroupName, saveUserTags } from "./groups.js";
import { MAX_OUTCOMES_PER_DAY, OUTCOME_CATEGORY, OUTCOME_STATUSES, buildSynthesisPrompt, findCandidateBundles, parseSynthesisResponse, readPlan, toBlueprint, topicFamily } from "./synthesis.js";
import { buildTranscriptSynopsisPrompt, buildVideoSynopsisPrompt, fetchYouTubeTranscript } from "./transcript.js";
import { WebFetchError, fetchWebContent } from "./webfetch.js";
import { SHARE_PRESET_LABELS, SHARE_TIER_LABELS, buildPresetPrompt, callClaude, parseSharePayload } from "./share.js";
import { renderSharePage } from "./share-page.js";
import { renderMissionControlPage } from "./mission-control-page.js";
import { ENGINE_TOKEN_TTL_SECONDS, mintEngineToken } from "./engine-token.js";
import { displayNameFor, loadAccount, loadPreferredName, normalizePreferredName } from "./user-profile.js";
import { seedOnboardingGraph } from "./onboarding.js";
import { graphEventFor, publishGraphEvent, subscribeGraphEvents } from "./graph-events.js";

// The live sync Durable Object (wrangler.jsonc durable_objects).
export { GraphEvents } from "./graph-events.js";
import { devRoleFor, ensureDevOperator, isDevAuthEnabled } from "./dev-auth.js";
import { ENGINE_RELAY_PREFIX, enginePublicUrl, relayToEngine } from "./engine-relay.js";
import { AEPS_SKILLS } from "./generated/aeps-skills.js";
import { DEFAULT_DEPTH, DEPTHS, normalizeDepth } from "../public/js/spatial/depth.js";
import { OAUTH_COOKIE, OAUTH_COOKIE_TTL_SECONDS, buildGoogleAuthUrl, createOAuthState, createPkcePair, exchangeGoogleCode, isAllowedGoogleEmail, readOAuthCookie, safeNextPath, signOAuthCookie, usernameFromEmail, verifyGoogleIdToken } from "./google-auth.js";

const VIDEO_URL_PATTERN = /(youtube\.com|youtu\.be|facebook\.com\/(reel|watch|share\/[rv]\/)|fb\.watch|instagram\.com\/(reel|tv)|tiktok\.com|vimeo\.com|x\.com\/i\/status|twitter\.com\/i\/status|\.mp4(\?|$)|\.webm(\?|$)|\.mov(\?|$)|\.m4v(\?|$))/i;

const VALID_CATEGORIES = ["note", "link", "article", "dev_task", "monetization", "ai_tool", "marketing", "route_plan", "general", "video", "image"];
// Board view columns (migration 0010). A NULL or unknown status reads as inbox, so new nodes land there.
export const NODE_STATUSES = ["inbox", "active", "reference", "done"];
const RECLUSTER_CATEGORIES = ["note", "general", "link", "article", "dev_task", "monetization", "ai_tool", "marketing", "route_plan"];

// Keeps each recluster request well under the Workers subrequest / D1 query limits:
// per node at most 1 context lookup + 1 Gemini call + 1 update.
const RECLUSTER_BATCH_SIZE = 10;
// One metadata fetch (4 s timeout) + one update per link.
const METADATA_BACKFILL_BATCH_SIZE = 10;
// Nodes per /api/remine request; one Gemini call per user found in the batch.
const REMINE_BATCH_SIZE = 20;
const MAX_SEMANTIC_LINKS_PER_NODE = 5;
// gemini-2.5-flash started returning 404 in July 2026; 3.x Flash models replace it.
// Tried in order: a model answering 503 (high demand) or 429 falls through to the next.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"];
const GEMINI_RETRYABLE_STATUSES = [429, 503];
// Share sheet "Gemini Pro" tier: Pro is only offered as a preview, so Flash takes over when it is busy.
const GEMINI_PRO_MODELS = ["gemini-3.1-pro-preview", "gemini-3.8-flash"];
// Ask Elarion routing: Tier 1 answers note questions cheaply; Tier 2 adds Google Search for research questions.
const ASK_TIER1_MODELS = ["gemini-3.5-flash-lite", "gemini-3.7-flash"]; // Flash only if Lite is busy (429/503)
const ASK_TIER2_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash"];
const WEB_RESEARCH_PATTERN = /\b(research(es|ed|ing)?|search(es|ed|ing)?|find online|latest|news|current rates?)\b/i;
// Caps the /api/ask prompt: one D1 lookup, at most this many nodes of ~300-char context each.
const ASK_MAX_NODES = 150;
const ASK_MAX_QUESTION_LENGTH = 1000;
const ASK_DESCRIPTION_LENGTH = 300;
// Limits for nodes created from the UI's "+" form.
const NODE_TITLE_MAX = 200;
const NODE_CONTENT_MAX = 5000;
// Ask history saved on the focused node: newest entries kept, answers trimmed so the graph payload stays small.
const RESEARCH_MAX_ENTRIES = 10;
const RESEARCH_ANSWER_MAX = 4000;
// Telegram: plain text sent this soon after a link is saved as a note on that link instead of a new node.
const LINK_PAIRING_WINDOW_SECONDS = 120;
const USER_NOTE_MAX = 4000;
// Telegram slash commands: one list feeds setMyCommands (the "/" autocomplete), /help, and the web app's help modal.
export const TELEGRAM_COMMANDS = [
  { command: "research", usage: "/research <topic or link>", description: "Deep AI research with live web synthesis, saved to your graph" },
  { command: "ask", usage: "/ask <question>", description: "Ask Elarion about your saved knowledge graph" },
  { command: "link", usage: "/link <url> [note]", description: "Save a URL as a link node, with an optional note" },
  { command: "note", usage: "/note <text>", description: "Save a standalone note, even right after a link" },
  { command: "help", usage: "/help", description: "Command guide and link pairing info" }
];
// Nodes sent as context with a Telegram /ask or /research: best keyword matches, then the most recent.
const TELEGRAM_CONTEXT_NODES = 40;
// Telegram rejects messages over 4096 characters; longer answers are split below that.
const TELEGRAM_MESSAGE_MAX = 3900;
const TELEGRAM_SOURCES_MAX = 5;
// Telegram photos: bots can download files up to 20 MB; images sent as files must be one of these raster types.
const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;
const TELEGRAM_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const IMAGE_TYPES_BY_EXTENSION = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
// Set once this isolate has published the command list.
let telegramCommandsRegistered = false;
// Daily cron mines at most this many users' backlogs (one Gemini call each).
const MINER_USERS_PER_RUN = 3;
// Session cookie auth: stateless HMAC-signed token; PBKDF2 at the Workers iteration cap.
const SESSION_COOKIE = "aether_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 100000;
const PASSWORD_MIN_LENGTH = 10;
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/i;
// Longest id a /node/<id> deep link accepts (ids are "node_" + a UUID).
const NODE_ID_MAX = 200;

const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with", "is", "https", "http", "com", "www"]);

export default {
  // Daily cron (wrangler.jsonc triggers): categorize unanalyzed nodes and mine relationship edges.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(mineConnections(env));
    if (env.TELEGRAM_TOKEN) {
      ctx.waitUntil(registerTelegramCommands(env).catch(err => console.warn("Telegram setMyCommands failed:", err.message)));
    }
  },

  // Every request goes through route(); a write that succeeded is then announced to the user's other open tabs.
  async fetch(request, env, ctx) {
    const response = await this.route(request, env, ctx);
    const event = response.ok ? graphEventFor(request.method, new URL(request.url).pathname) : null;
    if (event && env.GRAPH_EVENTS) ctx.waitUntil(announceWrite(request, env, event));
    return response;
  },

  async route(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint 0: Session auth (HttpOnly cookie) and admin-managed accounts
    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuthRoute(request, env, url);
    }

    // Endpoint 0a: The deployed version id (public). Long-lived pages (iOS keeps home-screen apps alive) compare it
    // with the version they were built from and offer a reload (public/js/update-check.js).
    // Live sync: the signed-in user's graph events as Server-Sent Events (src/graph-events.js).
    if (url.pathname === "/api/events") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      if (!env.GRAPH_EVENTS) return jsonResponse({ error: "Live sync is not configured.", configured: false }, 404);
      return subscribeGraphEvents(env, auth.user.id);
    }

    if (url.pathname === "/api/version") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
      return jsonResponse({ version: env.CF_VERSION_METADATA?.id || "dev" }, 200, { "Cache-Control": "no-store" });
    }

    // Endpoint 0b: The signed-in user's settings. PATCH with either or both of:
    //   connection_depth: "obvious" | "logical" | "abstract" - how far the engine reaches when it relates saves
    //   preferred_name: "<name>" | "" | null - display name for the header and Mission Control (src/user-profile.js)
    if (url.pathname === "/api/settings") {
      if (request.method !== "PATCH") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "PATCH" });
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const body = await request.json().catch(() => null);
      const changes = {};
      if (body?.connection_depth !== undefined) {
        if (!DEPTHS.includes(body.connection_depth)) return jsonResponse({ error: "connection_depth must be obvious, logical or abstract." }, 400);
        changes.connection_depth = body.connection_depth;
      }
      if (body?.preferred_name !== undefined) {
        const name = normalizePreferredName(body.preferred_name);
        if (!name.ok) return jsonResponse({ error: name.error }, 400);
        changes.preferred_name = name.value;
      }
      const columns = Object.keys(changes);
      if (!columns.length) return jsonResponse({ error: "Send connection_depth and/or preferred_name." }, 400);
      try {
        await env.DB.prepare("UPDATE users SET " + columns.map(c => c + " = ?").join(", ") + " WHERE id = ?")
          .bind(...columns.map(c => changes[c]), auth.user.id).run();
        return jsonResponse(changes);
      } catch (err) {
        console.error("Settings update failed:", err);
        return jsonResponse({ error: "Saving the setting failed." }, 500);
      }
    }

    // Endpoint 0c-2: Engine relay (src/engine-relay.js): the engine API through the portal's own domain, for devices
    // that can't reach the operator's localhost. Needs ENGINE_PUBLIC_URL (a tunnel to the engine); 404 without it.
    if (url.pathname === ENGINE_RELAY_PREFIX || url.pathname.startsWith(ENGINE_RELAY_PREFIX + "/")) {
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      return relayToEngine(request, env, url, auth.user, { profile: { preferred_name: await loadPreferredName(env, auth.user.id) } });
    }

    // Endpoint 0c: Engine token for Mission Control. A short-lived HS256 JWT the local Aether_Engine accepts, signed with
    // ENGINE_JWT_SECRET (the engine's SUPABASE_JWT_SECRET), so the browser never needs a pasted key. 404 when unset.
    if (url.pathname === "/api/engine/token") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      if (!env.ENGINE_JWT_SECRET) {
        return jsonResponse({ error: "Engine token minting is not configured (ENGINE_JWT_SECRET).", configured: false }, 404, { "Cache-Control": "no-store" });
      }
      const preferredName = await loadPreferredName(env, auth.user.id);
      return jsonResponse(await mintEngineToken(auth.user.id, env.ENGINE_JWT_SECRET, Date.now(), ENGINE_TOKEN_TTL_SECONDS, { preferred_name: preferredName }), 200, { "Cache-Control": "no-store" });
    }

    // Endpoint 1: API returning the signed-in user's JSON graph data
    if (url.pathname === "/api/graph" && request.method === "GET") {
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      try {
        const selectNodes = () => env.DB.prepare(
          "SELECT id, title, description, category, url, created_at, research, image_url, site_name, source_url, favicon_url, user_note, status, synopsis, raw_transcript IS NOT NULL AS has_transcript, content IS NOT NULL AS has_content, group_id, group_source, outcome_status, outcome_plan FROM saved_nodes WHERE user_id = ? AND NOT (category = 'outcome' AND outcome_status = 'dismissed')"
        ).bind(auth.user.id).all();
        let { results } = await selectNodes();
        // First sign-in: an empty graph gets the onboarding tutorial (once per user, src/onboarding.js).
        if (!results || results.length === 0) {
          try {
            if (await seedOnboardingGraph(env, auth.user.id)) ({ results } = await selectNodes());
          } catch (err) {
            console.error("Onboarding seed failed:", err);
          }
        }
        let outcomeInputs = new Map();
        try {
          outcomeInputs = await loadOutcomeInputs(env, auth.user.id);
        } catch (err) {
          console.error("Outcome input lookup failed:", err);
        }
        let groups = [];
        let tagsByNode = new Map();
        try {
          [groups, tagsByNode] = await Promise.all([listGroups(env, auth.user.id), loadNodeTags(env, auth.user.id)]);
        } catch (err) {
          console.error("Group and tag lookup failed:", err);
        }

        const nodes = (results || []).map(node => {
          const rawUrl = String(node.url || "");
          const category = inferNodeCategory(rawUrl, String(node.category || "note"));
          const title = String(node.title || rawUrl || "Saved Entry");
          return {
            id: node.id,
            name: title,
            title,
            group: category,
            category,
            description: node.description ? String(node.description) : null,
            url: rawUrl,
            type: category,
            created_at: toIsoTimestamp(node.created_at),
            research: parseResearch(node.research),
            image_url: node.image_url || null,
            site_name: node.site_name || null,
            source_url: node.source_url || null,
            favicon_url: node.favicon_url || null,
            user_note: node.user_note ? String(node.user_note) : null,
            status: normalizeNodeStatus(node.status),
            synopsis: node.synopsis ? String(node.synopsis) : null,
            has_transcript: Boolean(node.has_transcript),
            has_content: Boolean(node.has_content),
            group_id: node.group_id || null,
            group_source: node.group_source || null,
            tags: tagsByNode.get(node.id) || [],
            ...(category === OUTCOME_CATEGORY ? {
              outcome_status: node.outcome_status || "proposed",
              outcome_plan: readPlan(node.outcome_plan),
              outcome_inputs: outcomeInputs.get(node.id) || []
            } : {})
          };
        });

        const links = buildGraphLinks(nodes);
        links.push(...buildConceptLinks(nodes.map(node => node.id), tagsByNode, links));
        links.push(...buildSynthesisLinks(nodes));
        mergeMinedEdges(links, nodes, await loadMinedEdges(env, auth.user.id));
        const [connectionDepth, preferredName] = await Promise.all([loadConnectionDepth(env, auth.user.id), loadPreferredName(env, auth.user.id)]);
        return jsonResponse({ nodes, links, groups, connection_depth: connectionDepth, preferred_name: preferredName });
      } catch (e) {
        console.error("D1 Graph Fetch Error:", e);
        return jsonResponse({ nodes: [], links: [] });
      }
    }

    // Endpoint 2: Recluster nodes with Gemini, one batch per request (client pages through with ?cursor=)
    if (url.pathname === "/api/recluster") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      if (!isAuthorizedAdmin(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      const apiKey = env.GEMINI_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: "Gemini API key is missing." }, 500);
      }

      try {
        const cursor = Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0;
        const { results } = await env.DB.prepare(
          "SELECT rowid AS row_id, id, user_id, title, url, category, created_at FROM saved_nodes WHERE ai_processed_at IS NULL AND rowid > ? ORDER BY rowid LIMIT ?"
        ).bind(cursor, RECLUSTER_BATCH_SIZE).all();

        const nodes = results || [];
        let updated = 0;
        const analyzedIds = [];
        for (const node of nodes) {
          const result = await reclusterNode(env, apiKey, node);
          if (!result) continue;
          analyzedIds.push(node.id);
          if (result.changed) updated++;
        }

        // Only nodes Gemini actually answered for are marked; failures stay NULL and retry next run.
        if (analyzedIds.length) {
          await env.DB.prepare(
            `UPDATE saved_nodes SET ai_processed_at = CURRENT_TIMESTAMP WHERE id IN (${analyzedIds.map(() => "?").join(", ")})`
          ).bind(...analyzedIds).run();
        }

        return jsonResponse({
          processed: nodes.length,
          updated,
          nextCursor: nodes.length ? nodes[nodes.length - 1].row_id : cursor,
          done: nodes.length < RECLUSTER_BATCH_SIZE
        });
      } catch (err) {
        console.error("Recluster Execution Error:", err);
        return jsonResponse({ error: "Recluster failed." }, 500);
      }
    }

    // Endpoint 3: Backfill fetched titles/descriptions for links saved before ingestion enrichment
    if (url.pathname === "/api/backfill-metadata") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      if (!isAuthorizedAdmin(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      try {
        const cursor = Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0;
        const { results } = await env.DB.prepare(
          "SELECT rowid AS row_id, id, url FROM saved_nodes WHERE (title = url OR title LIKE 'http%' OR description IS NULL OR source_url IS NULL OR favicon_url IS NULL) AND (url LIKE 'http://%' OR url LIKE 'https://%') AND rowid > ? ORDER BY rowid LIMIT ?"
        ).bind(cursor, METADATA_BACKFILL_BATCH_SIZE).all();

        const nodes = results || [];
        const fetched = await Promise.all(nodes.map(node => fetchLinkMetadata(String(node.url).split(/\s+/)[0])));
        const updates = [];
        nodes.forEach((node, i) => {
          const metadata = fetched[i];
          if (!metadata) {
            // Nothing fetched: still replace a raw-URL title with a readable one ("Facebook Reel", "Page · site.com").
            updates.push(env.DB.prepare(
              "UPDATE saved_nodes SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (title = url OR title LIKE 'http%')"
            ).bind(fallbackLinkTitle(String(node.url).split(/\s+/)[0]), node.id));
            return;
          }
          // Rows picked only for a missing preview keep their (possibly AI-assigned) title and description.
          updates.push(env.DB.prepare(
            "UPDATE saved_nodes SET title = CASE WHEN title = url OR title LIKE 'http%' THEN ? ELSE title END, description = COALESCE(description, ?), image_url = ?, site_name = ?, source_url = ?, favicon_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(metadata.title, metadata.description, metadata.image, metadata.siteName, metadata.sourceUrl, metadata.favicon, node.id));
        });
        if (updates.length) await env.DB.batch(updates);

        return jsonResponse({
          processed: nodes.length,
          updated: updates.length,
          nextCursor: nodes.length ? nodes[nodes.length - 1].row_id : cursor,
          done: nodes.length < METADATA_BACKFILL_BATCH_SIZE
        });
      } catch (err) {
        console.error("Metadata Backfill Error:", err);
        return jsonResponse({ error: "Metadata backfill failed." }, 500);
      }
    }

    // Endpoint 3b: One-off backfill for nodes the daily miner analyzed before tags and groups existed: mines their tags
    // and concept groups (categories are left alone) and picks up #hashtags already in their notes. Paged like recluster.
    if (url.pathname === "/api/remine") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      if (!isAuthorizedAdmin(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ error: "Gemini API key is missing." }, 500);
      }

      try {
        const cursor = Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0;
        const { results } = await env.DB.prepare(
          "SELECT rowid AS row_id, id, user_id, title, url, category, user_note, group_id, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id IS NOT NULL AND (category IS NULL OR category != 'outcome') AND rowid > ? ORDER BY rowid LIMIT ?"
        ).bind(cursor, REMINE_BATCH_SIZE).all();
        const rows = results || [];
        const byUser = new Map();
        for (const row of rows) {
          if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
          byUser.get(row.user_id).push(row);
          // Notes keep their text in url; links carry the user's words in user_note.
          const text = [row.user_note, /^https?:/i.test(String(row.url || "")) ? "" : row.url].filter(Boolean).join(" ");
          await saveUserTags(env, row.user_id, row.id, text);
        }
        let updated = 0;
        for (const [userId, userRows] of byUser) {
          const result = await mineNodes(env, userId, userRows, { retag: false });
          if (result) updated += result.tagged;
        }
        return jsonResponse({
          processed: rows.length,
          updated,
          nextCursor: rows.length ? rows[rows.length - 1].row_id : cursor,
          done: rows.length < REMINE_BATCH_SIZE
        });
      } catch (err) {
        console.error("Remine Error:", err);
        return jsonResponse({ error: "Remine failed." }, 500);
      }
    }

    // Endpoint 3d: Run the synthesis pass now (it also runs after the daily miner). Admin-only; pages through users with
    // ?cursor=<offset>, a few per request. A manual run skips the daily limit (at most 2 new outcomes per user per run).
    if (url.pathname === "/api/synthesize") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      if (!isAuthorizedAdmin(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ error: "Gemini API key is missing." }, 500);
      }
      try {
        const cursor = Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0;
        const { results } = await env.DB.prepare(
          "SELECT user_id FROM saved_nodes WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY user_id LIMIT ? OFFSET ?"
        ).bind(MINER_USERS_PER_RUN, cursor).all();
        const users = results || [];
        let created = 0;
        const report = [];
        for (const { user_id: userId } of users) {
          const result = await synthesizeForUser(env, userId, { manual: true });
          created += result.created;
          report.push(result);
        }
        return jsonResponse({
          processed: users.length,
          updated: created,
          report,
          nextCursor: cursor + users.length,
          done: users.length < MINER_USERS_PER_RUN
        });
      } catch (err) {
        console.error("Synthesis Error:", err);
        return jsonResponse({ error: "Synthesis failed." }, 500);
      }
    }

    // Endpoint 3e: One outcome: POST /api/outcome/<id>/regenerate asks for a new plan from the same inputs;
    // GET /api/outcome/<id>/blueprint exports it as aether.blueprint/1 for Finish Line (SPATIAL_ARCHITECTURE.md 8.6).
    if (url.pathname.startsWith("/api/outcome/")) {
      const match = /^\/api\/outcome\/([^/]+)\/(regenerate|blueprint)$/.exec(url.pathname);
      if (!match) return jsonResponse({ error: "Not found" }, 404);
      const action = match[2];
      const method = action === "regenerate" ? "POST" : "GET";
      if (request.method !== method) {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: method });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      let id = "";
      try {
        id = decodeURIComponent(match[1]).trim();
      } catch (err) {
        id = "";
      }
      try {
        const outcome = await env.DB.prepare(
          "SELECT id, title, created_at, outcome_status, outcome_plan, outcome_fingerprint FROM saved_nodes WHERE id = ? AND user_id = ? AND category = 'outcome'"
        ).bind(id, auth.user.id).first();
        if (!outcome) return jsonResponse({ error: "Outcome not found." }, 404);
        if (action === "blueprint") {
          const inputs = (await loadOutcomeInputs(env, auth.user.id, id)).get(id) || [];
          const sources = await loadNodeSummaries(env, auth.user.id, inputs);
          const blueprint = toBlueprint({ ...outcome, created_at: toIsoTimestamp(outcome.created_at) }, readPlan(outcome.outcome_plan), sources);
          return jsonResponse(blueprint, 200, { "Content-Disposition": `inline; filename="aether-blueprint-${id}.json"` });
        }
        if (outcome.outcome_status === "accepted" || outcome.outcome_status === "sent") {
          return jsonResponse({ error: "This plan is accepted, so Elarion keeps it as it is." }, 409);
        }
        if (!env.GEMINI_API_KEY) return jsonResponse({ error: "Gemini is not configured." }, 400);
        const updated = await regenerateOutcome(env, auth.user.id, outcome);
        if (!updated) return jsonResponse({ error: "Elarion could not write a better plan from these saves right now. Try again later." }, 502);
        return jsonResponse(updated);
      } catch (err) {
        console.error("Outcome Route Error:", err);
        return jsonResponse({ error: "Outcome request failed." }, 500);
      }
    }

    // Endpoint 3c: The signed-in user's groups (AI-suggested and user-made): list and create at /api/groups, rename and
    // delete at /api/groups/<id>. Deleting a group leaves its nodes unsorted.
    if (url.pathname === "/api/groups" || url.pathname.startsWith("/api/groups/")) {
      const isItem = url.pathname.startsWith("/api/groups/");
      const allowed = isItem ? ["PATCH", "DELETE"] : ["GET", "POST"];
      if (!allowed.includes(request.method)) {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: allowed.join(", ") });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;

      try {
        if (!isItem) {
          if (request.method === "GET") return jsonResponse({ groups: await listGroups(env, userId) });
          const name = normalizeGroupName((await request.json().catch(() => null))?.name);
          if (!name) return jsonResponse({ error: `Group names must be 1-${GROUP_NAME_MAX} characters.` }, 400);
          return jsonResponse({ group: await ensureGroup(env, userId, name, "user") });
        }

        let id = "";
        try {
          id = decodeURIComponent(url.pathname.slice("/api/groups/".length)).trim();
        } catch (err) {
          id = "";
        }
        if (!id) return jsonResponse({ error: "Missing group id." }, 400);

        if (request.method === "PATCH") {
          const name = normalizeGroupName((await request.json().catch(() => null))?.name);
          if (!name) return jsonResponse({ error: `Group names must be 1-${GROUP_NAME_MAX} characters.` }, 400);
          const clash = await env.DB.prepare(
            "SELECT id FROM node_groups WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?"
          ).bind(userId, name, id).first();
          if (clash) return jsonResponse({ error: "You already have a group with that name." }, 409);
          // A renamed AI group is now the user's own, so the miner treats it like any user group.
          const result = await env.DB.prepare(
            "UPDATE node_groups SET name = ?, source = 'user' WHERE id = ? AND user_id = ?"
          ).bind(name, id, userId).run();
          if (!result?.meta?.changes) return jsonResponse({ error: "Group not found." }, 404);
          return jsonResponse({ group: { id, name, source: "user" } });
        }

        const [, groupResult] = await env.DB.batch([
          env.DB.prepare("UPDATE saved_nodes SET group_id = NULL, group_source = NULL WHERE group_id = ? AND user_id = ?").bind(id, userId),
          env.DB.prepare("DELETE FROM node_groups WHERE id = ? AND user_id = ?").bind(id, userId)
        ]);
        if (!groupResult?.meta?.changes) return jsonResponse({ error: "Group not found." }, 404);
        return jsonResponse({ deleted: id });
      } catch (err) {
        console.error("Group Route Error:", err);
        return jsonResponse({ error: "Group update failed." }, 500);
      }
    }

    // Endpoint 4a: Create a node from the UI, optionally linked to an existing node
    if (url.pathname === "/api/node") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;

      const body = await request.json().catch(() => null);
      const title = String(body?.title || "").trim();
      const category = String(body?.category || "").trim();
      const content = String(body?.content || "").trim().slice(0, NODE_CONTENT_MAX);
      const linkTargetId = body?.linkTargetId ? String(body.linkTargetId).trim() : "";
      if (!title || title.length > NODE_TITLE_MAX) {
        return jsonResponse({ error: `Title must be 1-${NODE_TITLE_MAX} characters.` }, 400);
      }
      if (!VALID_CATEGORIES.includes(category)) return jsonResponse({ error: "Unknown category." }, 400);

      try {
        if (linkTargetId) {
          const target = await env.DB.prepare("SELECT id FROM saved_nodes WHERE id = ? AND user_id = ?").bind(linkTargetId, userId).first();
          if (!target) return jsonResponse({ error: "Link target not found." }, 404);
        }

        const id = "node_" + crypto.randomUUID();
        // Content that is only a URL makes a link node, with its Open Graph preview fetched now.
        const linkUrl = /^https?:\/\/\S+$/i.test(content) ? cleanLinkUrl(content) : "";
        const metadata = linkUrl ? await fetchLinkMetadata(linkUrl) : null;
        const description = linkUrl ? (metadata?.description || null) : (content || null);
        const preview = {
          image_url: metadata?.image || null,
          site_name: metadata?.siteName || null,
          source_url: metadata?.sourceUrl || null,
          favicon_url: metadata?.favicon || null
        };
        // Marked as AI-processed so the daily cron keeps the category chosen by hand.
        const statements = [
          env.DB.prepare(
            "INSERT INTO saved_nodes (id, user_id, url, title, description, category, image_url, site_name, source_url, favicon_url, ai_processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
          ).bind(id, userId, linkUrl, title, description, category, preview.image_url, preview.site_name, preview.source_url, preview.favicon_url)
        ];
        if (linkTargetId) {
          // node_edges is undirected and stored with source_id < target_id.
          const [sourceId, targetId] = id < linkTargetId ? [id, linkTargetId] : [linkTargetId, id];
          statements.push(env.DB.prepare(
            "INSERT OR IGNORE INTO node_edges (source_id, target_id, relation, user_id) VALUES (?, ?, ?, ?)"
          ).bind(sourceId, targetId, "manual", userId));
        }
        await env.DB.batch(statements);
        const tags = await saveUserTags(env, userId, id, content);

        const node = {
          id,
          name: title,
          title,
          group: category,
          category,
          description,
          url: linkUrl,
          type: category,
          created_at: new Date().toISOString(),
          research: [],
          user_note: null,
          group_id: null,
          group_source: null,
          tags: tags.map(tag => ({ tag, source: "user", weight: 1 })),
          ...preview
        };
        const link = linkTargetId ? { source: id, target: linkTargetId, value: 2, type: "ai", relation: "manual", stored: true } : null;
        return jsonResponse({ success: true, node, link });
      } catch (err) {
        console.error("Node Create Error:", err);
        return jsonResponse({ error: "Create failed." }, 500);
      }
    }

    // Endpoint 4d: Stored links between two of the user's nodes. POST { source, target, relationship? } links them,
    // PATCH { source, target, relationship } relabels the link, DELETE { source, target } removes it.
    if (url.pathname === "/api/link") {
      const handlers = { POST: createUserLink, PATCH: updateUserLink, DELETE: deleteUserLink };
      const handler = handlers[request.method];
      if (!handler) {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST, PATCH, DELETE" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const body = await request.json().catch(() => null);
      try {
        const result = await handler(env, auth.user.id, body);
        return jsonResponse(result.body, result.status);
      } catch (err) {
        console.error("Link " + request.method + " Error:", err);
        return jsonResponse({ error: "Link update failed." }, 500);
      }
    }

    // Endpoint 4c: A Telegram photo node's image, fetched from Telegram on demand (the stored file_id never expires)
    if (url.pathname.startsWith("/api/node-image/")) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      let id = "";
      try {
        id = decodeURIComponent(url.pathname.slice("/api/node-image/".length)).trim();
      } catch (err) {
        id = "";
      }
      const row = id
        ? await env.DB.prepare("SELECT telegram_file_id FROM saved_nodes WHERE id = ? AND user_id = ?").bind(id, auth.user.id).first()
        : null;
      if (!row?.telegram_file_id) return jsonResponse({ error: "Image not found." }, 404);
      try {
        const file = await fetchTelegramFile(env, row.telegram_file_id);
        if (!file) return jsonResponse({ error: "Telegram no longer has this image." }, 502);
        return new Response(file.response.body, {
          headers: {
            "Content-Type": file.imageType,
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'"
          }
        });
      } catch (err) {
        console.error("Node image fetch failed:", err);
        return jsonResponse({ error: "Image fetch failed." }, 502);
      }
    }

    // Endpoint 4b: Move a node to another board column or group (PATCH), or delete it with its edges and tags (DELETE)
    if (url.pathname.startsWith("/api/node/")) {
      if (request.method !== "DELETE" && request.method !== "PATCH") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "PATCH, DELETE" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;
      let id = "";
      try {
        id = decodeURIComponent(url.pathname.slice("/api/node/".length)).trim();
      } catch (err) {
        id = "";
      }
      if (!id) return jsonResponse({ error: "Missing node id." }, 400);

      if (request.method === "PATCH") {
        const body = await request.json().catch(() => null);
        // Outcome review: { outcome_status: "accepted" | "dismissed" | "sent" } on an Outcome Node.
        if (body && Object.hasOwn(body, "outcome_status")) {
          const status = String(body.outcome_status || "").trim().toLowerCase();
          if (!OUTCOME_STATUSES.includes(status) || status === "proposed") {
            return jsonResponse({ error: "outcome_status must be accepted, dismissed or sent." }, 400);
          }
          try {
            const result = await env.DB.prepare(
              "UPDATE saved_nodes SET outcome_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND category = 'outcome'"
            ).bind(status, id, userId).run();
            if (!result?.meta?.changes) return jsonResponse({ error: "Outcome not found." }, 404);
            return jsonResponse({ id, outcome_status: status });
          } catch (err) {
            console.error("Outcome Status Error:", err);
            return jsonResponse({ error: "Update failed." }, 500);
          }
        }
        // Type changes from the 2D board: { category, group_id? } moves a card into another type's column, optionally
        // setting or clearing its group in the same write. Outcome Nodes keep their type, and a video link stays a video
        // (the graph re-detects it from the link on every load).
        if (body && Object.hasOwn(body, "category")) {
          const category = String(body.category || "").trim().toLowerCase();
          if (!VALID_CATEGORIES.includes(category)) {
            return jsonResponse({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}.` }, 400);
          }
          try {
            const row = await env.DB.prepare("SELECT category, url FROM saved_nodes WHERE id = ? AND user_id = ?").bind(id, userId).first();
            if (!row) return jsonResponse({ error: "Node not found." }, 404);
            if (String(row.category || "").toLowerCase() === OUTCOME_CATEGORY) return jsonResponse({ error: "Outcome cards keep their type." }, 400);
            if (VIDEO_URL_PATTERN.test(String(row.url || "")) && category !== "video") {
              return jsonResponse({ error: "A video link is always a video, so it stays in the video column." }, 400);
            }
            let group;
            if (Object.hasOwn(body, "group_id")) {
              group = null;
              if (body.group_id !== null) {
                const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";
                group = groupId ? await env.DB.prepare("SELECT id, name, source FROM node_groups WHERE id = ? AND user_id = ?").bind(groupId, userId).first() : null;
                if (!group) return jsonResponse({ error: "Group not found." }, 404);
              }
            }
            const statement = group === undefined
              ? env.DB.prepare("UPDATE saved_nodes SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").bind(category, id, userId)
              : env.DB.prepare("UPDATE saved_nodes SET category = ?, group_id = ?, group_source = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").bind(category, group ? group.id : null, id, userId);
            await statement.run();
            return jsonResponse({ id, category, ...(group === undefined ? {} : { group, group_source: "user" }) });
          } catch (err) {
            console.error("Node Category Error:", err);
            return jsonResponse({ error: "Update failed." }, 500);
          }
        }
        // Group changes: { group_id: "<id>" }, { new_group: "Name" } (created if new) or { group_id: null } (no group).
        // Any of them marks the choice as the user's, which the miner never overrides.
        if (body && (Object.hasOwn(body, "group_id") || Object.hasOwn(body, "new_group"))) {
          try {
            const node = await env.DB.prepare("SELECT id FROM saved_nodes WHERE id = ? AND user_id = ?").bind(id, userId).first();
            if (!node) return jsonResponse({ error: "Node not found." }, 404);
            let group = null;
            if (Object.hasOwn(body, "new_group")) {
              const name = normalizeGroupName(body.new_group);
              if (!name) return jsonResponse({ error: `Group names must be 1-${GROUP_NAME_MAX} characters.` }, 400);
              group = await ensureGroup(env, userId, name, "user");
            } else if (body.group_id !== null) {
              const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";
              if (!groupId) return jsonResponse({ error: "group_id must be a group id or null." }, 400);
              group = await env.DB.prepare("SELECT id, name, source FROM node_groups WHERE id = ? AND user_id = ?").bind(groupId, userId).first();
              if (!group) return jsonResponse({ error: "Group not found." }, 404);
            }
            await env.DB.prepare(
              "UPDATE saved_nodes SET group_id = ?, group_source = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
            ).bind(group ? group.id : null, id, userId).run();
            return jsonResponse({ id, group, group_source: "user" });
          } catch (err) {
            console.error("Node Group Update Error:", err);
            return jsonResponse({ error: "Update failed." }, 500);
          }
        }
        const status = typeof body?.status === "string" ? body.status.trim().toLowerCase() : "";
        if (!NODE_STATUSES.includes(status)) {
          return jsonResponse({ error: `status must be one of: ${NODE_STATUSES.join(", ")}.` }, 400);
        }
        try {
          const result = await env.DB.prepare(
            "UPDATE saved_nodes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
          ).bind(status, id, userId).run();
          if (!result?.meta?.changes) return jsonResponse({ error: "Node not found." }, 404);
          return jsonResponse({ id, status });
        } catch (err) {
          console.error("Node Status Update Error:", err);
          return jsonResponse({ error: "Update failed." }, 500);
        }
      }

      try {
        const [, , , nodeResult] = await env.DB.batch([
          env.DB.prepare("DELETE FROM node_edges WHERE user_id = ? AND (source_id = ? OR target_id = ?)").bind(userId, id, id),
          env.DB.prepare("DELETE FROM node_tags WHERE user_id = ? AND node_id = ?").bind(userId, id),
          env.DB.prepare("DELETE FROM outcome_inputs WHERE user_id = ? AND (outcome_id = ? OR node_id = ?)").bind(userId, id, id),
          env.DB.prepare("DELETE FROM saved_nodes WHERE id = ? AND user_id = ?").bind(id, userId)
        ]);
        if (!nodeResult?.meta?.changes) return jsonResponse({ error: "Node not found." }, 404);
        return jsonResponse({ deleted: id });
      } catch (err) {
        console.error("Node Delete Error:", err);
        return jsonResponse({ error: "Delete failed." }, 500);
      }
    }

    // Endpoint 5: Ask Elarion (Gemini) about a node's neighborhood or a whole cluster
    if (url.pathname === "/api/ask") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ error: "Gemini API key is missing." }, 500);
      }

      const body = await request.json().catch(() => null);
      const question = String(body?.question || "").trim();
      const label = String(body?.label || "").trim().slice(0, 100);
      const focusId = body?.focusId ? String(body.focusId) : null;
      const nodeIds = Array.isArray(body?.nodeIds)
        ? [...new Set(body.nodeIds.map(String).filter(Boolean))].slice(0, ASK_MAX_NODES)
        : [];
      if (!question || question.length > ASK_MAX_QUESTION_LENGTH) {
        return jsonResponse({ error: `Question must be 1-${ASK_MAX_QUESTION_LENGTH} characters.` }, 400);
      }
      if (!nodeIds.length) return jsonResponse({ error: "No nodes to ask about." }, 400);

      try {
        // Context comes from D1, not the client, so the prompt only ever contains stored nodes.
        const { results } = await env.DB.prepare(
          `SELECT id, title, description, category, url, user_note FROM saved_nodes WHERE user_id = ? AND id IN (${nodeIds.map(() => "?").join(", ")})`
        ).bind(userId, ...nodeIds).all();
        if (!results?.length) return jsonResponse({ error: "None of those nodes exist." }, 404);

        let reply;
        try {
          reply = await askGemini(env, question, webSearch => buildAskPrompt(question, label, focusId, results, webSearch));
        } catch (err) {
          console.error("Ask Gemini Error:", err);
          return jsonResponse({ error: "Elarion could not answer right now." }, 502);
        }
        const answer = reply.text.trim();
        if (!answer) return jsonResponse({ error: "Elarion returned an empty answer." }, 502);

        // Node-card questions are saved on the focused node; cluster questions (no focusId) are not.
        let research = null;
        if (focusId && results.some(row => row.id === focusId)) {
          try {
            research = await appendResearch(env, userId, focusId, { question, answer, sources: reply.sources });
          } catch (err) {
            console.warn("Ask research save failed:", err.message);
          }
        }
        return jsonResponse({ answer, sources: reply.sources, tier: reply.tier, research });
      } catch (err) {
        console.error("Ask Error:", err);
        return jsonResponse({ error: "Ask failed." }, 500);
      }
    }

    // Endpoint 5b: YouTube Transcript Pipeline. GET returns what a video node has stored; POST fetches the
    // captions and a Gemini synopsis and saves them (stored results are reused unless "refresh" is set).
    if (url.pathname === "/api/transcript") {
      if (request.method !== "GET" && request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      const id = String((body ? body.id : url.searchParams.get("id")) || "").trim();
      if (!id) return jsonResponse({ error: "Missing node id." }, 400);

      try {
        const node = await env.DB.prepare(
          "SELECT id, title, url, raw_transcript, synopsis FROM saved_nodes WHERE id = ? AND user_id = ?"
        ).bind(id, userId).first();
        if (!node) return jsonResponse({ error: "Node not found." }, 404);
        const videoId = getYouTubeVideoId(cleanLinkUrl(String(node.url || "")));
        const stored = { id, videoId, transcript: node.raw_transcript || null, synopsis: node.synopsis || null, source: "stored" };
        if (request.method === "GET") return jsonResponse(stored);
        if (!videoId) return jsonResponse({ error: "Only YouTube video nodes have transcripts." }, 400);
        if ((stored.transcript || stored.synopsis) && body?.refresh !== true) return jsonResponse(stored);

        const captions = await fetchYouTubeTranscript(videoId);
        // Without captions Gemini watches the video itself; without a key the transcript is still saved.
        let synopsis = null;
        if (env.GEMINI_API_KEY) {
          try {
            const reply = captions
              ? await callGeminiText(env.GEMINI_API_KEY, GEMINI_MODELS, buildTranscriptSynopsisPrompt(node.title, captions.text), 2048, false)
              : await callGeminiText(env.GEMINI_API_KEY, GEMINI_MODELS, buildVideoSynopsisPrompt(node.title), 2048, false, "https://www.youtube.com/watch?v=" + videoId);
            synopsis = reply.text.trim() || null;
          } catch (err) {
            console.warn("Transcript synopsis failed:", err.message);
          }
        }
        if (!captions && !synopsis) {
          return jsonResponse({ error: "Could not get captions or a synopsis for this video." }, 502);
        }

        // A refresh that comes back with less than before keeps the stored value.
        await env.DB.prepare(
          "UPDATE saved_nodes SET raw_transcript = COALESCE(?, raw_transcript), synopsis = COALESCE(?, synopsis), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
        ).bind(captions ? captions.text : null, synopsis, id, userId).run();
        return jsonResponse({
          id,
          videoId,
          transcript: captions ? captions.text : stored.transcript,
          synopsis: synopsis || stored.synopsis,
          source: captions ? "captions" : "video",
          language: captions ? captions.language : null,
          autoCaptions: captions ? captions.auto : null
        });
      } catch (err) {
        console.error("Transcript Error:", err);
        return jsonResponse({ error: "Transcript failed." }, 500);
      }
    }

    // Endpoint 5c: Web Content Fetcher. POST { url?, nodeId? } downloads a page as readable text and, with a nodeId,
    // saves it on that node (the node's own link is used when no url is given). GET ?id= returns the stored text.
    if (url.pathname === "/api/web-fetch") {
      if (request.method !== "GET" && request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;

      if (request.method === "GET") {
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) return jsonResponse({ error: "Missing node id." }, 400);
        const row = await env.DB.prepare("SELECT id, content FROM saved_nodes WHERE id = ? AND user_id = ?").bind(id, userId).first();
        if (!row) return jsonResponse({ error: "Node not found." }, 404);
        return jsonResponse({ success: true, id, content: row.content || null });
      }

      const body = await request.json().catch(() => null);
      const nodeId = body?.nodeId ? String(body.nodeId).trim() : "";
      let target = String(body?.url || "").trim();
      try {
        if (nodeId) {
          const node = await env.DB.prepare("SELECT id, url FROM saved_nodes WHERE id = ? AND user_id = ?").bind(nodeId, userId).first();
          if (!node) return jsonResponse({ error: "Node not found." }, 404);
          if (!target) target = String(node.url || "");
        }
        if (!target) return jsonResponse({ error: "Missing url." }, 400);
        const page = await fetchWebContent(target);
        if (nodeId) {
          await env.DB.prepare("UPDATE saved_nodes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
            .bind(page.content, nodeId, userId).run();
        }
        return jsonResponse({ success: true, content: page.content, title: page.title, url: page.url });
      } catch (err) {
        if (err instanceof WebFetchError) return jsonResponse({ success: false, error: err.message }, err.status);
        console.error("Web Fetch Error:", err);
        return jsonResponse({ success: false, error: "Web fetch failed." }, 500);
      }
    }

    // Endpoint 5d: Share sheet ingest. Saves the node to the inbox at once; metadata and the chosen preset run afterwards.
    if (url.pathname === "/api/share") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      const userId = auth.user.id;
      const parsed = parseSharePayload(await request.json().catch(() => null));
      if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
      const share = parsed.value;
      if (share.preset && share.tier === "claude" && !env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: "Claude Sonnet is not configured yet; pick a Gemini tier." }, 400);
      }
      if (share.preset && share.tier !== "claude" && !env.GEMINI_API_KEY) {
        return jsonResponse({ error: "Gemini is not configured." }, 400);
      }

      try {
        const id = "node_" + crypto.randomUUID();
        const linkUrl = share.url ? cleanLinkUrl(share.url) : "";
        const category = linkUrl ? inferNodeCategory(linkUrl, "link") : (share.note.length > 100 ? "article" : "note");
        const title = share.title || (linkUrl ? fallbackLinkTitle(linkUrl) : share.note.slice(0, 80));
        // An action task goes straight to the Active column; everything else lands in the inbox.
        const status = share.preset === "task" ? "active" : "inbox";
        await env.DB.prepare(
          "INSERT INTO saved_nodes (id, user_id, url, title, category, user_note, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, userId, linkUrl || share.note, title, category, linkUrl ? (share.note || null) : null, status).run();
        await saveUserTags(env, userId, id, share.note);
        ctx.waitUntil(processSharedNode(env, userId, id, { ...share, url: linkUrl, hasSharedTitle: Boolean(share.title) }));
        return jsonResponse({ success: true, id, title, status });
      } catch (err) {
        console.error("Share Ingest Error:", err);
        return jsonResponse({ error: "Saving failed." }, 500);
      }
    }

    // Endpoint 5d: Mission Control (src/mission-control-page.js): Elarion, the agent task monitor and the circuit breaker
    // for the local Aether_Engine. Signed-out visitors sign in first and come back here.
    if (url.pathname === "/mission-control") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      const session = await getSessionUser(request, env);
      if (!session) {
        return Response.redirect(url.origin + "/?next=" + encodeURIComponent("/mission-control"), 303);
      }
      // Tier gates the blueprint dashboard's Deploy & Execute action (Pro); everything else is open to every tier.
      // The greeting and operator card use the preferred name when one is set, else the username.
      const account = await loadAccount(env, session.id);
      return new Response(renderMissionControlPage({
        assetVersion: env.CF_VERSION_METADATA?.id || "dev",
        tier: account?.tier || "free",
        userName: displayNameFor(account),
        role: devRoleFor(env, url, session.id) || "",
        // The engine relay and the engine's public address (for the Engine State link) when ENGINE_PUBLIC_URL is set.
        enginePublicUrl: enginePublicUrl(env) || "",
        upgradeUrl: env.PRO_UPGRADE_URL || "",
        // ?theme= (from the Engine status page) wins over the saved cookie, so the first paint already matches.
        theme: url.searchParams.get("theme") || readCookie(request, "aether_theme") || ""
      }), {
        headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" }
      });
    }

    // Endpoint 5d-2: AEPS skills registry for Mission Control's Skills tab. The SKILL.md playbooks linked under
    // .aether/skills/AEPS/ are bundled at build time (scripts/build-skills-index.mjs); they are proprietary, so only
    // signed-in users get them.
    if (url.pathname === "/api/skills/aeps") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      return jsonResponse(AEPS_SKILLS, 200, { "Cache-Control": "private, no-store" });
    }

    // Endpoint 5e: PWA share target (manifest share_target). Signed-out visitors sign in first and come back here.
    if (url.pathname === "/share") {
      if (request.method !== "GET" && request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
      }
      const fields = request.method === "POST" ? await request.formData().catch(() => null) : url.searchParams;
      const read = name => String(fields?.get(name) || "").trim();
      const shared = { url: read("url"), title: read("title"), text: read("text") };
      if (!await getSessionUser(request, env)) {
        const query = new URLSearchParams(Object.entries(shared).filter(([, value]) => value)).toString();
        return Response.redirect(url.origin + "/?next=" + encodeURIComponent("/share" + (query ? "?" + query : "")), 303);
      }
      return new Response(renderSharePage(shared, { claudeAvailable: Boolean(env.ANTHROPIC_API_KEY) }), {
        headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" }
      });
    }

    // Endpoint 5f: Deep link to one node (/node/<id>, e.g. the share sheet's View Node button). Signed-in visits get
    // the usual app, whose client script opens that node's card; signed-out visitors sign in first and come back here.
    const nodeRoute = parseNodeRoute(url.pathname);
    if (nodeRoute && request.method !== "POST") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      if (!nodeRoute.id) return Response.redirect(url.origin + "/", 303);
      if (!await getSessionUser(request, env)) {
        return Response.redirect(url.origin + "/?next=" + encodeURIComponent("/node/" + encodeURIComponent(nodeRoute.id)), 303);
      }
    }

    // Endpoint 6: Telegram Webhook POST
    if (request.method === "POST") {
      if (url.pathname !== "/") {
        return new Response("Not found", { status: 404 });
      }
      if (!isAuthorizedTelegram(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Workers have no startup hook: the first webhook each isolate handles (re)registers the "/" autocomplete.
      if (!telegramCommandsRegistered && env.TELEGRAM_TOKEN) {
        telegramCommandsRegistered = true;
        ctx.waitUntil(registerTelegramCommands(env).catch(err => {
          telegramCommandsRegistered = false;
          console.warn("Telegram setMyCommands failed:", err.message);
        }));
      }

      let telegramUserId = null;
      try {
        const update = await request.json();
        const chatId = update.message?.chat?.id;
        const text = String(update.message?.text || "").trim();

        if (!chatId) return new Response("OK");

        const owner = await env.DB.prepare("SELECT id FROM users WHERE telegram_chat_id = ?").bind(String(chatId)).first();
        if (!owner) {
          await sendTelegram(env, chatId, `This chat isn't linked to an Aether account (chat id: ${chatId}).`);
          return new Response("OK");
        }
        const userId = owner.id;
        telegramUserId = userId;
        const image = pickTelegramImage(update.message);
        if (image) {
          await saveTelegramImage(env, chatId, userId, { ...image, caption: String(update.message.caption || "").trim() });
          return new Response("OK");
        }
        if (!text) {
          await sendTelegram(env, chatId, "Send text, links or photos to save them. Send /help for the command guide.");
          return new Response("OK");
        }

        const command = parseTelegramCommand(text);
        if (command) {
          await handleTelegramCommand(env, chatId, userId, command);
          return new Response("OK");
        }

        const message = splitLinkMessage(text);
        if (message.url) {
          // A link, with any text sent in the same message kept as its note.
          await saveTelegramLink(env, chatId, userId, message.url, message.note);
          return new Response("OK");
        }

        // Plain text right after a link is a comment on it: attach instead of creating a node.
        const recentLink = await findRecentLinkContext(env, userId, null, null, LINK_PAIRING_WINDOW_SECONDS);
        if (recentLink && await attachUserNote(env, userId, recentLink.id, text)) {
          await sendTelegram(
            env,
            chatId,
            `📎 Added your note to "${recentLink.title || recentLink.url}".\nTo save it as its own node instead, send /note followed by the text.`
          );
          return new Response("OK");
        }

        await saveTelegramNote(env, chatId, userId, text);
        return new Response("OK");
      } catch (err) {
        console.error("Worker Execution Error:", err.message, err.stack);
        return new Response("OK");
      } finally {
        // Whatever the message saved (a link, note, photo or research), the user's open tabs pick it up.
        if (telegramUserId && env.GRAPH_EVENTS) {
          ctx.waitUntil(publishGraphEvent(env, telegramUserId, { type: "graph.changed" }).catch(err => console.warn("Live sync publish failed:", err.message)));
        }
      }
    }

    // Endpoint 5: Mobile-Optimized 3D Visualizer UI
    // NOTE: this is a template literal - avoid backslashes and ${ } in the client script below.
    // Each deploy has its own version id, so the module entry URL changes and no browser keeps last deploy's code.
    const assetVersion = encodeURIComponent(env.CF_VERSION_METADATA?.id || "dev");
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Aether Portal - 3D Knowledge Graph</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#080c14">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <meta name="google-client-id" content="${escapeHtmlText(env.GOOGLE_CLIENT_ID || "")}">
  <meta name="aether-dev-login" content="${isDevAuthEnabled(env, url) ? "1" : ""}">
  <meta name="aether-version" content="${assetVersion}">
  <style>
    /* DESIGN.md, main portal: navy surfaces and a teal accent for the brand, selected states and primary buttons;
       6-8px corners, hairline borders, no backdrop blur, glows or heavy shadows. */
    :root {
      --bg-page: #080c14;
      --bg-panel: #0b1320;
      --bg-raised: rgba(255,255,255,0.04);
      --hairline: 1px solid rgba(255,255,255,0.08);
      --text: #dffdf7;
      --text-muted: #8a93a6;
      --accent: #00ffcc;
      --accent-line: rgba(0,255,204,0.55);
      --accent-soft: rgba(0,255,204,0.14);
      --on-accent: #041016;
      --active-fill: linear-gradient(135deg, rgba(0,255,204,0.3), rgba(79,132,255,0.3));
      --radius-s: 6px;
      --radius-m: 8px;
    }
    body { margin: 0; overflow: hidden; background-color: var(--bg-page); font-family: system-ui, -apple-system, sans-serif; touch-action: none; }
    #topbar {
      position: absolute;
      top: 10px;
      left: 10px;
      right: 10px;
      height: 44px;
      box-sizing: border-box;
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: var(--hairline);
    }
    #topbar .brand { color: var(--accent); font-size: 14px; font-weight: 600; white-space: nowrap; }
    #topbar .user-greeting { color: #8a93a6; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
    #topbar .user-greeting[hidden] { display: none; }
    #topbar .bar-spacer { flex: 1; }
    .bar-btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      height: 30px;
      box-sizing: border-box;
      padding: 0 12px;
      border: var(--hairline);
      border-radius: var(--radius-s);
      background: var(--bg-raised);
      color: var(--text);
      font-size: 12px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    #search-input {
      appearance: none;
      flex: 0 1 180px;
      min-width: 0;
      height: 30px;
      box-sizing: border-box;
      border: var(--hairline);
      background: var(--bg-raised);
      color: var(--text);
      border-radius: var(--radius-s);
      padding: 0 12px;
      font-size: 12px;
      outline: none;
    }
    #search-input::placeholder { color: var(--text-muted); }
    #search-input:focus { border-color: var(--accent-line); }
    #filter-menu summary { list-style: none; }
    #filter-menu summary::-webkit-details-marker { display: none; }
    #filter-menu[open] summary { background: rgba(0,255,204,0.18); border-color: rgba(0,255,204,0.6); }
    .filter-dropdown {
      position: absolute;
      top: 40px;
      right: 0;
      width: 280px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: var(--hairline);
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-pill, .toggle-button, #time-filter, #type-filter, #group-by, #collection-sort {
      appearance: none;
      border: var(--hairline);
      background: var(--bg-raised);
      color: var(--text);
      border-radius: var(--radius-s);
      padding: 7px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .filter-pill.active, .toggle-button.active {
      background: var(--active-fill);
      border-color: var(--accent-line);
      color: #ffffff;
    }
    #time-filter, #type-filter, #group-by { min-width: 140px; color: #dffdf7; }
    #time-filter option, #type-filter option, #group-by option { background: #0b1320; }
    .filter-field { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: #8a93a6; }
    .filter-badge { min-width: 16px; height: 16px; margin-left: 6px; padding: 0 4px; box-sizing: border-box; border-radius: 4px; background: var(--accent); color: var(--on-accent); font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; }
    .filter-badge[hidden] { display: none; }
    .filters-reset { appearance: none; margin-top: 2px; padding: 6px; border: none; border-top: 1px solid rgba(255,255,255,0.08); background: none; color: var(--accent); font-size: 12px; cursor: pointer; }
    .filters-reset:hover, .filters-reset:focus-visible { text-decoration: underline; outline: none; }
    .toggle-button {
      font-weight: 600;
    }
    #add-node-button { font-size: 18px; line-height: 1; border-color: var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 700; }
    /* Filter toolbar: a second row under the header (32px tall, ends at about 92px; panels below start at 102px+).
       The origin filters are one segmented control; the Filters popover sits at its right end. */
    /* Outcome Nodes (SPATIAL_ARCHITECTURE.md section 8): the plan view in the node card, in Outcome Gold. */
    #node-card.is-outcome h3, #cluster-drawer.is-outcome h3 { color: #ffb627; text-transform: none; }
    #node-card.is-outcome .card-tag { border-color: rgba(255, 182, 39, 0.7); background: rgba(255, 182, 39, 0.1); color: #ffb627; }
    #cluster-drawer.is-outcome .mini-card.active { border-color: #ffb627; background: rgba(255, 182, 39, 0.08); }
    #node-card .card-outcome { margin: 0 0 12px; padding: 10px 12px; border-left: 2px solid #ffb627; border-radius: var(--radius-s); background: rgba(255, 182, 39, 0.07); }
    #node-card .card-outcome[hidden] { display: none; }
    .card-outcome-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .card-outcome-badge { padding: 2px 6px; border: 1px solid rgba(255, 182, 39, 0.7); border-radius: 4px; color: #ffb627; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; }
    .card-outcome-meta { color: #d9c7a0; font-size: 11px; }
    #node-card .card-outcome-goal { margin: 0 0 8px; color: #fff; font-size: 13px; }
    .card-outcome-steps { margin: 0 0 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; color: #e8dcc0; font-size: 12px; line-height: 1.45; }
    .card-outcome-steps strong { display: block; color: #fff; font-size: 13px; }
    .card-outcome-sources { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .card-outcome-sources button { appearance: none; max-width: 180px; padding: 2px 6px; overflow: hidden; border: 1px solid rgba(255, 182, 39, 0.35); border-radius: 4px; background: transparent; color: #d9c7a0; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .card-outcome-sources button:hover, .card-outcome-sources button:focus-visible { border-color: #ffb627; color: #fff; outline: none; }
    .card-outcome-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .card-outcome-link { display: inline-flex; align-items: center; min-height: 32px; padding: 0 10px; box-sizing: border-box; border: 1px solid var(--accent-line); border-radius: var(--radius-s); color: var(--accent); font-size: 12px; text-decoration: none; }
    .card-outcome-actions button { appearance: none; min-height: 32px; padding: 0 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-raised); color: var(--text); font-size: 12px; cursor: pointer; }
    .card-outcome-actions #outcome-accept { border-color: #ffb627; background: #ffb627; color: #1a1406; font-weight: 700; }
    .card-outcome-actions button:disabled { opacity: 0.45; cursor: progress; }
    .card-outcome-message { display: block; min-height: 1em; margin-top: 6px; color: #d9c7a0; font-size: 11px; }
    /* Time scope stepper (semantic zoom): shorter or longer time span of cards. */
    #scope-stepper { display: inline-flex; flex: none; align-items: center; gap: 2px; height: 32px; padding: 2px; box-sizing: border-box; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-panel); }
    #scope-stepper button { position: relative; appearance: none; width: 28px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text); font-size: 16px; line-height: 1; cursor: pointer; }
    #scope-stepper button::after { content: ''; position: absolute; inset: -9px -2px; }
    #scope-stepper button:hover:not(:disabled), #scope-stepper button:focus-visible { border-color: var(--accent-line); outline: none; }
    #scope-stepper button:active:not(:disabled) { transform: scale(0.98); }
    #scope-stepper button:disabled { opacity: 0.35; cursor: default; }
    #scope-label { min-width: 92px; padding: 0 4px; color: #fff; font-size: 12px; font-weight: 600; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
    #filter-toolbar {
      position: absolute;
      top: 60px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 29;
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: calc(100% - 20px);
      box-sizing: border-box;
    }
    #platform-bar {
      display: flex;
      flex: 0 1 auto;
      min-width: 0;
      height: 32px;
      box-sizing: border-box;
      overflow-x: auto;
      scrollbar-width: none;
      touch-action: pan-x;
      gap: 2px;
      padding: 2px;
      border-radius: var(--radius-s);
      border: var(--hairline);
      background: var(--bg-panel);
    }
    #platform-bar::-webkit-scrollbar { display: none; }
    .platform-pill {
      flex: none;
      appearance: none;
      height: 100%;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--text);
      font-size: 12px;
      white-space: nowrap;
      cursor: pointer;
    }
    .platform-pill:hover:not(:disabled), .platform-pill:focus-visible { background: rgba(0,255,204,0.08); outline: none; }
    .platform-pill[aria-pressed="true"] { background: var(--active-fill); border-color: var(--accent-line); color: #fff; font-weight: 600; }
    .platform-pill:disabled { opacity: 0.4; cursor: default; }
    #filter-menu { position: relative; flex: none; }
    #filter-menu summary { height: 32px; background: var(--bg-panel); }
    #telegram-help-button { gap: 6px; flex: none; }
    .bar-icon { width: 14px; height: 14px; flex: none; }
    .settings-option.phone-only { display: none; }
    #telegram-help-button svg { width: 14px; height: 14px; flex: none; }
    .help-panel { width: min(600px, 94vw); }
    .help-panel .reader-body { white-space: normal; font-size: 13px; line-height: 1.55; }
    .help-panel h4 { margin: 18px 0 6px; font-size: 13px; color: var(--accent); }
    .help-panel p { margin: 0 0 10px; }
    .help-panel .help-lead { color: #aab3c5; }
    .help-panel code { padding: 1px 6px; border-radius: 6px; background: rgba(0,255,204,0.1); color: var(--accent); font-size: 12px; white-space: nowrap; }
    .command-list { display: flex; flex-direction: column; gap: 6px; }
    .command-row {
      display: grid;
      grid-template-columns: minmax(170px, auto) 1fr;
      gap: 10px;
      align-items: baseline;
      padding: 8px 10px;
      border-radius: var(--radius-s);
      background: var(--bg-raised);
      border: var(--hairline);
    }
    .command-row span { color: #dffdf7; }
    .help-steps { margin: 0 0 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
    #view-switch {
      display: inline-flex;
      flex: none;
      height: 30px;
      box-sizing: border-box;
      gap: 2px;
      padding: 2px;
      border: var(--hairline);
      border-radius: var(--radius-s);
      overflow: hidden;
      background: var(--bg-panel);
    }
    #view-switch button {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 0 11px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--text);
      font-size: 12px;
      white-space: nowrap;
      cursor: pointer;
    }
    #view-switch button[aria-pressed="true"] { background: var(--active-fill); border-color: var(--accent-line); color: #fff; font-weight: 600; }
    #view-switch .view-icon { font-size: 13px; line-height: 1; }
    /* Connection depth: a compact three-stop slider in the top bar (Obvious, Logical, Abstract). */
    .depth-control {
      display: inline-flex;
      flex-direction: column;
      justify-content: center;
      gap: 1px;
      height: 30px;
      box-sizing: border-box;
      padding: 0 10px;
      border: var(--hairline);
      border-radius: var(--radius-s);
      background: var(--bg-raised);
    }
    .depth-control input[type="range"] {
      width: 150px;
      height: 12px;
      margin: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .depth-stops { display: flex; justify-content: space-between; width: 150px; font-size: 9px; line-height: 1; color: #8a93a6; }
    .depth-stops span.active { color: var(--accent); font-weight: 700; }
    /* Spatial zoom: a four-stop slider in the top bar (Space, Cluster, Horizon, Atomic), styled like the depth slider. */
    .zoom-control {
      display: inline-flex;
      flex-direction: column;
      justify-content: center;
      gap: 1px;
      height: 30px;
      box-sizing: border-box;
      padding: 0 10px;
      border: var(--hairline);
      border-radius: var(--radius-s);
      background: var(--bg-raised);
    }
    .zoom-control input[type="range"] {
      width: 168px;
      height: 12px;
      margin: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .zoom-stops { display: flex; justify-content: space-between; width: 168px; font-size: 9px; line-height: 1; color: #8a93a6; }
    .zoom-stops span { cursor: pointer; }
    .zoom-stops span.active { color: var(--accent); font-weight: 700; }
    body.collection-mode .zoom-control,
    body.flat-board .zoom-control { display: none; }
    /* Stop 4 (Atomic) on wide screens: the group list slides out to the left so the card has the room between it and
       the details, and slides back at stop 3. Transform and opacity only, so nothing reflows mid-move; visibility
       drops once it is out so it takes no clicks or focus. The camera frames for the end state (getCardCover). */
    @media (min-width: 768px) {
      #cluster-drawer { transition: transform 0.3s ease, opacity 0.3s ease, visibility 0s linear 0s; }
      body.zoom-atomic #cluster-drawer {
        transform: translateX(calc(-100% - 24px));
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: transform 0.3s ease, opacity 0.3s ease, visibility 0s linear 0.3s;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #cluster-drawer, body.zoom-atomic #cluster-drawer { transition: none; }
    }
    body.collection-mode .depth-control,
    body.collection-mode #view-toggle,
    body.collection-mode #legend { display: none !important; }
    /* Control wheel: the concentric control rings in the bottom-right corner (public/js/spatial/thumb-wheel.js), thumb-
       sized on phones, where it takes over the view switch, 2D toggle, Add, time stepper, depth slider, platform pills
       and board layouts, and a larger widget beside the toolbars on desktop (mouse drag, scroll wheel). */
    #thumb-wheel {
      position: fixed;
      right: 0;
      bottom: 0;
      z-index: 15;
      /* --wheel-grow (thumb-wheel.js) enlarges the corner when three or four rings are out, so they keep their width. */
      width: calc(232px * var(--wheel-grow, 1));
      height: calc(232px * var(--wheel-grow, 1));
      touch-action: none;
      /* It steps aside for the open card by a transform (below), which eases without reflowing anything; right and
         bottom only change with the view (List, Timeline, Board, Carousel). */
      transition: transform 0.3s ease, opacity 0.3s ease, right 300ms cubic-bezier(0.25, 1, 0.5, 1), bottom 300ms cubic-bezier(0.25, 1, 0.5, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      #thumb-wheel { transition: none; }
    }
    body.xr-presenting #thumb-wheel { display: none; }
    .thumb-wheel-svg { display: block; overflow: hidden; pointer-events: none; font-family: inherit; user-select: none; -webkit-user-select: none; }
    .thumb-wheel-svg path, .thumb-wheel-svg text { pointer-events: auto; cursor: grab; }
    .thumb-wheel-svg .thumb-wheel-hub path, .thumb-wheel-svg .thumb-wheel-hub text { cursor: pointer; }
    .thumb-wheel-svg .thumb-wheel-mark { pointer-events: none; }
    .thumb-wheel-svg g:focus { outline: none; }
    .thumb-wheel-svg g:focus-visible path:first-child { stroke: var(--accent-line); }
    /* The visual click (the only one where the phone cannot vibrate): the index marks flick wider for a moment. */
    .thumb-wheel-svg .thumb-wheel-mark { transform-box: fill-box; transform-origin: center; }
    .thumb-wheel-svg.clicked .thumb-wheel-mark { animation: wheel-click 120ms ease-out; }
    @keyframes wheel-click { 0% { transform: scale(1.6); } 100% { transform: scale(1); } }
    /* Wheel mode: Simple keeps to the View rim and the primary ring; Advanced telescopes the inner rings out. The switch
       rides just above the wheel's corner. The buttons are 30px tall, with an invisible hit area reaching 44px (::after)
       so they are easy to hit with a thumb. */
    .wheel-actions { position: absolute; top: -40px; right: 6px; z-index: 1; display: flex; gap: 10px; }
    #wheel-home, #wheel-mode { position: relative; }
    #wheel-home::after, #wheel-mode::after { content: ''; position: absolute; inset: -7px -5px; }
    #wheel-home {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 12px 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 15px;
      background: #0a111c;
      color: #8a93a6;
      font-family: inherit;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    #wheel-home svg { width: 14px; height: 14px; }
    #wheel-home:hover, #wheel-home:focus-visible { border-color: var(--accent-line); color: var(--accent); outline: none; }
    #wheel-mode {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 12px 0 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 15px;
      background: #0a111c;
      color: #8a93a6;
      font-family: inherit;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    #wheel-mode .wheel-mode-track { position: relative; width: 20px; height: 12px; border-radius: 6px; background: #122033; }
    #wheel-mode .wheel-mode-knob { position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: #8a93a6; transition: left 160ms ease-out, background 160ms ease-out; }
    #wheel-mode[aria-checked="true"] { color: var(--accent); }
    #wheel-mode[aria-checked="true"] .wheel-mode-knob { left: 10px; background: var(--accent); }
    #wheel-mode:focus-visible { outline: 1px solid var(--accent-line); outline-offset: 1px; }
    /* Desktop: the card sidebar comes down the right edge, so the wheel moves to its left while a card is open. Over the
       List, Timeline, Board and Carousel it stands in from the corner by the list's scrollbar (--scrollbar-w, measured
       from script) and a small gap, so the scrollbar and its arrows stay reachable. */
    @media (min-width: 768px) {
      body.collection-mode #thumb-wheel { right: calc(var(--scrollbar-w, 0px) + 6px); bottom: 6px; }
      /* Slid well clear of the open card's panel, not tucked against its edge. */
      body.card-open #thumb-wheel { transform: translateX(calc(-1 * (clamp(340px, 27vw, 420px) + 44px))); }
      body.collection-mode #collection-view { padding-bottom: 240px; }
    }
    @media (max-width: 767px) {
      #thumb-wheel {
        bottom: env(safe-area-inset-bottom, 0px);
        width: calc(164px * var(--wheel-grow, 1));
        height: calc(164px * var(--wheel-grow, 1));
      }
      /* The graph library's mouse hint means nothing on a touch screen, and sits under the wheel. */
      .scene-nav-info { display: none; }
      /* Above the node card's peek sheet; out of the way while a sheet is expanded. */
      body.card-open #thumb-wheel { transform: translateY(calc(env(safe-area-inset-bottom, 0px) - 24vh - 16px)); }
      body:has(#node-card.expanded) #thumb-wheel,
      body:has(#cluster-drawer.expanded) #thumb-wheel { display: none; }
      #view-switch, #view-toggle, #add-node-button, #scope-stepper, #depth-control, #platform-bar, #board-modes { display: none !important; }
    }
    /* Phones: the group list at Horizon is a small tab beside the wheel; tapping its title opens the full sheet. */
    @media (max-width: 600px) {
      #cluster-drawer:not(.expanded) { right: 176px; max-height: none; }
      #cluster-drawer:not(.expanded) > :not(.drawer-head):not(#drawer-close) { display: none !important; }
      #cluster-drawer .drawer-head { cursor: pointer; }
    }
    body.collection-mode [id="3d-graph"] { display: none; }
    #collection-view {
      display: none;
      position: fixed;
      top: 104px;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 5;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-y;
      padding: 4px 16px 24px;
      box-sizing: border-box;
      color: #dffdf7;
    }
    body.collection-mode #collection-view { display: block; }
    body.collection-mode.card-open #collection-view { padding-bottom: 55vh; }
    .collection-inner { max-width: 1100px; margin: 0 auto; }
    #collection-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px auto 12px; max-width: 820px; font-size: 12px; color: #8a93a6; }
    #collection-toolbar.wide { max-width: none; }
    #collection-count { flex: 1; min-width: 80px; }
    #collection-toolbar [hidden] { display: none; }
    #collection-sort option { background: #0b1320; }
    .collection-list { display: flex; flex-direction: column; gap: 8px; max-width: 820px; margin: 0 auto; }
    .collection-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
    .item-card {
      position: relative;
      isolation: isolate;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      box-sizing: border-box;
      padding: 12px 14px;
      border-radius: var(--radius-m);
      border: var(--hairline);
      background: var(--bg-panel);
      color: var(--text);
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .item-card:hover, .item-card:focus-visible { border-color: rgba(0,255,204,0.45); background: rgba(0,255,204,0.07); outline: none; }
    .item-card.active { border-color: var(--accent); }
    .item-card.timeline { padding: 9px 12px; gap: 4px; }
    /* Board view: four status columns; cards move between them by drag and drop or the card's status pills. */
    body.board-mode #collection-view { touch-action: pan-x pan-y; }
    .board-view { display: grid; grid-template-columns: repeat(4, minmax(240px, 1fr)); gap: 12px; align-items: start; overflow-x: auto; padding-bottom: 6px; }
    .board-column {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-radius: var(--radius-m);
      border: var(--hairline);
      border-top: 3px solid var(--column);
      background: rgba(255,255,255,0.02);
      transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
    }
    .board-column-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 8px; font-size: 13px; font-weight: 600; color: #fff; }
    .board-count { min-width: 22px; padding: 1px 7px; box-sizing: border-box; border-radius: 4px; background: rgba(255,255,255,0.08); color: #aab3c5; font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
    .board-column-body { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 10px; min-height: 90px; }
    .board-empty { display: flex; align-items: center; justify-content: center; min-height: 72px; border: 1px dashed rgba(255,255,255,0.12); border-radius: var(--radius-s); color: #6b7385; font-size: 12px; }
    .board-column.drop-target { border-color: var(--column); background: rgba(255,255,255,0.06); box-shadow: inset 0 0 0 1px var(--column); }
    .item-card.board { padding: 10px 12px; gap: 4px; cursor: grab; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease, opacity 0.15s ease; }
    .item-card.board .item-title { font-size: 13px; }
    .item-card.board.pressing { transform: scale(0.97); }
    .item-card.drag-source { opacity: 0.35; }
    /* The card following the pointer; above the node card (20), below the top bar (30). */
    .item-card.board-ghost { position: fixed; left: 0; top: 0; z-index: 25; margin: 0; pointer-events: none; transition: none; border-color: var(--accent); box-shadow: 0 8px 20px rgba(0,0,0,0.45); opacity: 0.95; }
    body.board-dragging, body.board-dragging * { cursor: grabbing !important; }
    /* Carousel view: the cards on the curved Horizon wall, dragged or swiped sideways to turn it. The card in front
       faces the viewer; the ones either side come forward and turn in along the arc and run off the edges. The
       stage's perspective (the arc's radius) and every card's transform are set from script. */
    .deck-view { display: flex; flex-direction: column; align-items: center; gap: 12px; overflow: hidden; margin: 0 -16px; padding: 6px 0 4px; }
    .deck-stage { position: relative; width: 100%; height: clamp(300px, calc(100vh - 270px), 580px); perspective-origin: 50% 50%; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
    .item-card.carousel {
      position: absolute;
      top: 0;
      left: calc(50% - min(220px, 38vw));
      width: min(440px, 76vw);
      bottom: 40px;
      backface-visibility: hidden;
      gap: 8px;
      /* Opaque so the cards underneath don't show through the top one. */
      background: var(--bg-panel);
      border-color: rgba(0,255,204,0.18);
      box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      transform-origin: 50% 50%;
      transition: transform 0.34s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.34s ease, border-color 0.15s ease;
    }
    /* Only the top card casts a shadow, and cards are promoted to their own layers only while dragged: five blurred,
       permanently promoted layers were heavy for a standalone headset's browser. */
    .item-card.carousel.behind { box-shadow: none; }
    .deck-stage.dragging .item-card.carousel { will-change: transform, opacity; }
    .item-card.carousel:hover, .item-card.carousel:focus-visible { background: #0e1a27; }
    .item-card.carousel.active { border-color: var(--accent); }
    .item-card.carousel.behind { cursor: pointer; }
    .item-card.carousel.beyond { pointer-events: none; }
    .item-card.carousel img { -webkit-user-drag: none; }
    .item-card.carousel .item-cover { flex: none; }
    .item-card.carousel .item-title { font-size: 17px; }
    .item-card.carousel .item-preview { flex: 1 1 auto; min-height: 0; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
    .item-card.carousel .item-foot { margin-top: auto; }
    .deck-stage.dragging .item-card.carousel { transition: none; cursor: grabbing; }
    .deck-controls { display: flex; align-items: center; gap: 14px; }
    .deck-btn { width: 38px; height: 38px; border-radius: var(--radius-s); border: 1px solid rgba(0,255,204,0.35); background: rgba(0,255,204,0.08); color: #dffdf7; font-size: 20px; line-height: 1; cursor: pointer; }
    .deck-btn:hover, .deck-btn:focus-visible { background: rgba(0,255,204,0.2); outline: none; }
    .deck-btn:disabled { opacity: 0.3; cursor: default; }
    .deck-counter { min-width: 72px; text-align: center; font-size: 13px; color: #aab3c5; font-variant-numeric: tabular-nums; }
    .deck-hint { max-width: calc(100% - 32px); font-size: 11px; color: #6b7385; text-align: center; }
    @media (prefers-reduced-motion: reduce) {
      .item-card.carousel { transition: none; }
    }
    .card-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
    .card-status-label { font-size: 11px; color: #8a93a6; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 2px; }
    .card-status button {
      appearance: none;
      padding: 3px 9px;
      border-radius: var(--radius-s);
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: #aab3c5;
      font-size: 11px;
      cursor: pointer;
    }
    .card-status button:hover, .card-status button:focus-visible { border-color: var(--column); color: #fff; outline: none; }
    .card-status button[aria-pressed="true"] { border-color: var(--column); background: rgba(255,255,255,0.1); color: #fff; box-shadow: inset 0 0 0 1px var(--column); }
    /* 16:9 frames with contain: YouTube thumbnails and link previews show uncropped, letterboxed if needed. */
    .item-cover { position: relative; margin: -12px -14px 2px; aspect-ratio: 16 / 9; height: auto; max-height: 220px; overflow: hidden; background: rgba(0,0,0,0.45); }
    .item-cover img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center; }
    .item-cover.placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      background: radial-gradient(circle at 30% 25%, var(--chip-soft, rgba(0,255,204,0.2)), rgba(8,12,20,0.95) 75%);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .item-cover.placeholder .item-cover-host { position: absolute; left: 12px; bottom: 8px; display: flex; align-items: center; gap: 6px; font-size: 11px; color: #dffdf7; opacity: 0.85; }
    .item-play {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 42px;
      height: 42px;
      margin: -21px 0 0 -21px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding-left: 3px;
      box-sizing: border-box;
      background: rgba(8,12,20,0.7);
      border: 1px solid rgba(255,255,255,0.35);
      color: #fff;
      font-size: 16px;
      pointer-events: none;
    }
    .item-card.list.has-thumb { display: grid; grid-template-columns: minmax(0, 1fr) 112px; column-gap: 12px; row-gap: 6px; align-items: start; }
    .item-card.list.has-thumb > :not(.item-thumb) { grid-column: 1; }
    .item-thumb { grid-column: 2; grid-row: 1 / span 5; width: 112px; aspect-ratio: 16 / 9; height: auto; border-radius: 8px; object-fit: contain; object-position: center; background: rgba(0,0,0,0.45); }
    .item-note { font-size: 12px; color: #fff3d1; line-height: 1.4; overflow-wrap: anywhere; padding-left: 8px; border-left: 2px solid rgba(255,209,102,0.6); }
    .item-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #8a93a6; }
    .item-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--chip, #8a93a6);
      color: var(--chip, #8a93a6);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .item-date { margin-left: auto; flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* Group picker chips (public/js/spatial/group-picker.js) shrink before the date does. */
    .item-head .gp-chip { flex: 0 1 auto; }
    .card-group { display: inline-flex; min-width: 0; }
    .card-group:empty { display: none; }
    .item-title { font-size: 14px; font-weight: 600; color: #fff; line-height: 1.3; overflow-wrap: anywhere; }
    .item-preview { font-size: 12px; color: #aab3c5; line-height: 1.45; overflow-wrap: anywhere; }
    .item-foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #8a93a6; min-width: 0; }
    .item-foot .item-site { min-width: 0; overflow-wrap: anywhere; }
    .item-foot a { margin-left: auto; flex: none; color: var(--accent); font-weight: 700; text-decoration: none; }
    .collection-empty { text-align: center; color: #8a93a6; padding: 48px 16px; font-size: 13px; }
    .collection-empty button { margin-top: 12px; }
    .timeline { max-width: 820px; margin: 0 auto; }
    .timeline-section h4 {
      position: sticky;
      top: -4px;
      z-index: 1;
      margin: 0;
      padding: 10px 0 8px;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      background: linear-gradient(#080c14 75%, rgba(8,12,20,0));
    }
    .timeline-items {
      list-style: none;
      margin: 0 0 10px 6px;
      padding: 0 0 0 18px;
      border-left: 2px solid rgba(0,255,204,0.2);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .timeline-items li { position: relative; }
    .timeline-items li::before {
      content: '';
      position: absolute;
      left: -25px;
      top: 14px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--dot, var(--accent));
      box-shadow: 0 0 0 3px #080c14;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.55);
    }
    .modal-backdrop[hidden] { display: none; }
    .modal-panel {
      width: min(420px, 92vw);
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 18px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: var(--hairline);
      color: #dffdf7;
    }
    .modal-panel h3 { margin: 0 0 4px; color: var(--accent); font-size: 16px; }
    .modal-panel label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: rgba(223,253,247,0.75); }
    .modal-panel input, .modal-panel select, .modal-panel textarea {
      border: var(--hairline);
      background: var(--bg-raised);
      color: var(--text);
      border-radius: var(--radius-s);
      padding: 8px 10px;
      font: inherit;
      font-size: 13px;
    }
    .modal-panel select option { background: #0b1320; }
    .modal-panel textarea { resize: vertical; }
    .modal-error { margin: 0; min-height: 1em; font-size: 12px; color: #ff6b81; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .modal-actions button { cursor: pointer; }
    .modal-panel input:focus, .modal-panel select:focus, .modal-panel textarea:focus { outline: none; border-color: var(--accent-line); }
    .modal-actions button[type="submit"] { border-color: var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 700; }
    .settings-wrap { position: relative; }
    .view-toggle.active { background: rgba(0,255,204,0.18); border-color: rgba(0,255,204,0.6); }
    .settings-menu {
      position: absolute;
      right: 0;
      top: 40px;
      width: 220px;
      background: var(--bg-panel);
      border: var(--hairline);
      border-radius: var(--radius-m);
      padding: 10px;
      display: none;
    }
    .settings-menu.open {
      display: block;
    }
    /* Signed-out landing: a quiet, Apple-style card with Google sign-in first and the password form tucked below. */
    #login-gate {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      background: radial-gradient(circle at 50% 30%, rgba(0,255,204,0.10), transparent 62%), var(--bg-page);
    }
    #login-gate[hidden] { display: none; }
    .login-panel {
      width: min(380px, 100%);
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 14px;
      padding: 36px 28px 26px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: var(--hairline);
      color: #f5f5f7;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif;
      text-align: center;
      box-sizing: border-box;
    }
    .login-logo { width: 64px; height: 64px; margin: 0 auto 2px; border-radius: var(--radius-m); }
    .login-panel h2 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: #f5f5f7; }
    .login-panel .login-sub { margin: -6px 0 10px; font-size: 15px; line-height: 1.4; color: #a1a1a6; }
    .google-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      height: 44px;
      border-radius: var(--radius-m);
      background: #fff;
      color: #1f1f1f;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      transition: transform 0.15s ease, opacity 0.15s ease;
    }
    .google-button:hover { opacity: 0.9; }
    .google-button:focus-visible { outline: 2px solid rgba(255,255,255,0.5); outline-offset: 2px; }
    .google-button:active { transform: scale(0.98); }
    .google-button[hidden] { display: none; }
    .google-button svg { width: 20px; height: 20px; flex: none; }
    .google-button.dev-button { background: transparent; color: var(--accent); border: 1px solid var(--accent-line); }
    .login-error { margin: 0; min-height: 1em; font-size: 13px; color: #ff6b81; }
    .login-error:empty { display: none; }
    .settings-option {
      width: 100%;
      border: var(--hairline);
      background: var(--bg-raised);
      color: #fff;
      border-radius: var(--radius-s);
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      margin-top: 8px;
    }
    #node-card {
      position: absolute;
      bottom: 25px;
      left: 15px;
      right: 15px;
      box-sizing: border-box;
      touch-action: pan-y;
      color: #fff;
      /* Above the cluster drawer (11), legend (9) and list view (5); below the platform bar and top bar
         (29/30), whose Filter and Settings menus must stay on top, and below modals (40). */
      z-index: 20;
      background: var(--bg-panel);
      padding: 16px 20px;
      border-radius: var(--radius-m);
      border: 1px solid rgba(0, 255, 204, 0.3);
      display: none;
      max-height: calc(100vh - 110px);
      overflow-y: auto;
    }
    #node-card .card-close {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 10;
      background: none;
      border: none;
      color: #8a93a6;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
    }
    #node-card .card-close:hover { color: var(--accent); }
    #node-card .card-delete {
      position: absolute;
      top: 12px;
      right: 44px;
      z-index: 10;
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: 0;
      background: none;
      border: none;
      border-radius: 6px;
      color: #ef4444;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    #node-card .card-delete svg { width: 18px; height: 18px; flex-shrink: 0; display: block; }
    #node-card .card-delete:hover,
    #node-card .card-delete:focus-visible { background: rgba(239, 68, 68, 0.15); outline: none; }
    #node-card .card-delete:disabled { opacity: 0.4; cursor: wait; }
    .ask-box { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
    .ask-row { display: flex; gap: 6px; align-items: stretch; }
    .ask-box textarea {
      flex: 1;
      min-height: 38px;
      max-height: 120px;
      resize: vertical;
      padding: 8px 10px;
      border-radius: var(--radius-s);
      border: var(--hairline);
      background: var(--bg-raised);
      color: #fff;
      font: inherit;
      font-size: 12px;
    }
    .ask-box textarea:focus { outline: none; border-color: var(--accent-line); }
    .ask-box button {
      padding: 0 14px;
      border-radius: var(--radius-s);
      border: 1px solid rgba(0,255,204,0.55);
      background: rgba(0,255,204,0.12);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }
    .ask-box button:disabled { opacity: 0.5; cursor: wait; }
    .ask-answer {
      display: none;
      max-height: 30vh;
      overflow-y: auto;
      padding: 8px 10px;
      border-radius: var(--radius-s);
      background: rgba(0,255,204,0.06);
      border-left: 2px solid var(--accent);
      color: #dffdf7;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .ask-answer.error { border-left-color: #ff4d6d; color: #ffb3c1; }
    .ask-turn + .ask-turn { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
    .ask-q { margin-bottom: 4px; color: #8a93a6; font-weight: 600; }
    .ask-q::before { content: 'You: '; color: var(--accent); }
    .ask-a.pending { color: #8a93a6; }
    .ask-a.error { color: #ffb3c1; }
    .spawn-button {
      display: none;
      align-self: flex-start;
      padding: 6px 12px;
      border-radius: var(--radius-s);
      border: 1px solid rgba(0,255,204,0.55);
      background: rgba(0,255,204,0.12);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }
    .card-research { display: none; margin-top: 10px; font-size: 12px; }
    .card-research summary { cursor: pointer; color: var(--accent); font-weight: 700; }
    .card-research-list { max-height: 26vh; overflow-y: auto; margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
    .research-entry { padding: 6px 8px; border-radius: var(--radius-s); background: rgba(255,255,255,0.04); }
    .research-entry summary { color: #fff; font-weight: 600; font-size: 12px; }
    .research-entry .research-date { color: #8a93a6; font-size: 10px; margin-left: 6px; font-weight: 400; }
    .research-entry .research-body { margin-top: 6px; color: #dffdf7; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .research-entry .spawn-button { display: inline-block; margin-top: 8px; }
    #node-card .card-preview {
      display: none;
      margin: 0 0 10px;
      border-radius: var(--radius-s);
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.03);
    }
    #node-card .card-preview img { display: block; width: 100%; aspect-ratio: 16 / 9; height: auto; max-height: 220px; object-fit: contain; object-position: center; background: rgba(0,0,0,0.45); }
    #node-card .card-preview img[hidden] { display: none; }
    #node-card .card-preview-bar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; }
    #node-card .card-site { flex: 1; min-width: 0; font-size: 12px; font-weight: 700; color: #dffdf7; overflow-wrap: anywhere; }
    .favicon {
      width: 16px;
      height: 16px;
      flex: none;
      border-radius: 4px;
      object-fit: contain;
      background: rgba(255,255,255,0.08);
    }
    #node-card .card-preview-bar .favicon { width: 20px; height: 20px; }
    #node-card .card-note {
      display: none;
      margin: 0 0 12px;
      padding: 8px 10px;
      border-radius: var(--radius-s);
      border-left: 2px solid #ffd166;
      background: rgba(255, 209, 102, 0.08);
    }
    #node-card .card-note-label { display: block; margin-bottom: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #ffd166; }
    #node-card .card-note-text { font-size: 13px; color: #fff3d1; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow-y: auto; }
    #node-card .card-preview-bar a { flex: none; }
    /* YouTube nodes: synopsis and transcript actions from /api/transcript. */
    #node-card .card-transcript { margin: 0 0 12px; padding: 8px 10px; border-radius: var(--radius-s); border-left: 2px solid #ff5a5a; background: rgba(255, 90, 90, 0.07); }
    #node-card .card-transcript[hidden] { display: none; }
    #node-card .card-transcript-label { display: block; margin-bottom: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #ff8a8a; }
    #node-card .card-synopsis { margin-bottom: 8px; font-size: 13px; color: #ffe4e4; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow-y: auto; }
    #node-card .card-synopsis:empty { display: none; }
    #node-card .card-transcript-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    #node-card .card-transcript-actions button { appearance: none; padding: 4px 10px; border-radius: var(--radius-s); border: 1px solid rgba(255,138,138,0.5); background: rgba(255,90,90,0.1); color: #ffd9d9; font-size: 12px; cursor: pointer; }
    #node-card .card-transcript-actions button:hover:not(:disabled), #node-card .card-transcript-actions button:focus-visible { background: rgba(255,90,90,0.22); outline: none; }
    #node-card .card-transcript-actions button:disabled { opacity: 0.55; cursor: progress; }
    #node-card .card-transcript-actions button[hidden] { display: none; }
    #node-card .card-transcript-status { font-size: 11px; color: #aab3c5; }
    #node-card .card-transcript-status.error { color: #ff8a8a; }
    /* Web links: the same action row in the app's teal. */
    #node-card .card-web { margin: 0 0 12px; }
    #node-card .card-web[hidden] { display: none; }
    #node-card .card-web .card-transcript-actions button { border-color: rgba(0,255,204,0.5); background: rgba(0,255,204,0.08); color: #c9fff3; }
    #node-card .card-web .card-transcript-actions button:hover:not(:disabled), #node-card .card-web .card-transcript-actions button:focus-visible { background: rgba(0,255,204,0.2); }
    #node-card .card-description { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow-y: auto; }
    .reader-button {
      display: none;
      margin: -4px 0 12px;
      padding: 6px 12px;
      border-radius: var(--radius-s);
      border: 1px solid rgba(0,255,204,0.55);
      background: rgba(0,255,204,0.12);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }
    .card-link-button {
      margin: 0 0 12px;
      padding: 6px 12px;
      border-radius: var(--radius-s);
      border: 1px solid rgba(0,255,204,0.55);
      background: rgba(0,255,204,0.08);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }
    .card-link-button:hover, .card-link-button:focus-visible { background: rgba(0,255,204,0.2); }
    #link-pick-hint[hidden] { display: none; }
    .card-links { margin: 0 0 10px; }
    .card-links[hidden] { display: none; }
    .card-links-label { display: block; margin-bottom: 6px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(223,253,247,0.6); }
    .card-links-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 30vh; overflow-y: auto; }
    .card-link-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto; gap: 6px; align-items: center; }
    .card-link-row .card-link-target {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 4px 0;
      border: 0;
      background: none;
      color: var(--accent);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .card-link-row input {
      min-width: 0;
      padding: 4px 8px;
      border: var(--hairline);
      border-radius: var(--radius-s);
      background: var(--bg-raised);
      color: var(--text);
      font: inherit;
      font-size: 12px;
    }
    .card-link-row input:focus { outline: none; border-color: var(--accent-line); }
    .card-link-row button.card-link-save, .card-link-row button.card-link-delete {
      padding: 4px 8px;
      border: 1px solid rgba(0,255,204,0.4);
      border-radius: var(--radius-s);
      background: rgba(0,255,204,0.08);
      color: var(--accent);
      font-size: 12px;
      cursor: pointer;
    }
    .card-link-row button.card-link-save:disabled { opacity: 0.35; cursor: default; }
    .card-link-row button.card-link-delete { border-color: rgba(255,107,129,0.45); background: rgba(255,107,129,0.08); color: #ff8fa0; }
    .card-links-status { display: block; min-height: 1em; margin-top: 4px; font-size: 11px; color: rgba(223,253,247,0.6); }
    .card-links-status.error { color: #ff6b81; }
    #link-pick-hint button { cursor: pointer; }
    .reader-panel {
      position: relative;
      width: min(760px, 94vw);
      max-height: 86vh;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 20px 22px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: 1px solid rgba(0, 255, 204, 0.3);
      color: #dffdf7;
      box-sizing: border-box;
    }
    .reader-panel h3 { margin: 0; padding-right: 32px; color: var(--accent); font-size: 17px; line-height: 1.3; }
    .reader-panel .reader-meta { margin: 0; font-size: 11px; color: #8a93a6; letter-spacing: 0.04em; }
    .reader-panel .card-close {
      position: absolute;
      top: 10px;
      right: 12px;
      background: none;
      border: none;
      color: #8a93a6;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
    }
    .reader-panel .card-close:hover { color: var(--accent); }
    .reader-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding-right: 6px;
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* An embedded video in the reader: full width, 16:9, never taller than half the screen (it narrows to keep 16:9). */
    .reader-video {
      position: relative;
      width: min(100%, calc(50vh * 16 / 9));
      aspect-ratio: 16 / 9;
      margin: 0 auto 14px;
      border-radius: var(--radius-s);
      overflow: hidden;
      background: #000;
      white-space: normal;
    }
    .reader-video iframe, .reader-video video { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .reader-panel a {
      align-self: flex-start;
      background: var(--accent);
      color: #0b0f19;
      padding: 8px 14px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
      font-size: 12px;
    }
    /* The group list is the left sidebar and the node card the right one, so the centre of the screen stays open for
       the focused 3D card (and the gallery arrows between them). */
    #cluster-drawer {
      position: absolute;
      top: 102px;
      left: 12px;
      bottom: 20px;
      width: 320px;
      box-sizing: border-box;
      z-index: 11;
      display: none;
      flex-direction: column;
      gap: 10px;
      padding: 14px 16px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: 1px solid rgba(0, 255, 204, 0.3);
      color: #fff;
    }
    #cluster-drawer.open { display: flex; }
    /* 2D board (Phase 5): a header above each column, placed over the canvas every frame and faded in with the morph. */
    #xr-button[hidden] { display: none; }
    .xr-wrap { position: relative; display: inline-flex; }
    .xr-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 40;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 240px;
      padding: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--radius-m);
      background: var(--bg-panel);
    }
    .xr-menu[hidden] { display: none; }
    .xr-menu button {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      min-height: 44px;
      padding: 8px 12px;
      border: 1px solid transparent;
      border-radius: var(--radius-s);
      background: none;
      color: #dffdf7;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .xr-menu button:hover, .xr-menu button:focus-visible { border-color: var(--accent-line); background: var(--accent-soft); outline: none; }
    .xr-menu strong { font-size: 13px; }
    .xr-menu span { font-size: 11px; color: #8a93a6; }
    #board-headers { position: fixed; inset: 0; z-index: 6; pointer-events: none; overflow: hidden; }
    #board-headers[hidden], body.collection-mode #board-headers { display: none; }
    /* The column headers name every column, so the legend would only cover the board. */
    body.flat-board #legend { display: none !important; }
    .board-header {
      position: absolute;
      left: 0;
      top: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border: 1px solid rgba(255,255,255,0.08);
      border-top: 3px solid var(--accent);
      border-radius: var(--radius-s);
      background: var(--bg-panel);
      color: #dffdf7;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
    }
    .board-header-label { overflow: hidden; text-overflow: ellipsis; text-transform: capitalize; }
    .board-header-count { color: #8a93a6; font-weight: 400; }
    #board-hint, #link-pick-hint {
      position: fixed;
      left: 50%;
      bottom: 96px;
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 25;
      max-width: min(90vw, 460px);
      padding: 10px 14px;
      transform: translateX(-50%);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      color: #dffdf7;
      font-size: 13px;
    }
    #board-hint[hidden] { display: none; }
    #board-hint button {
      flex: none;
      min-height: 36px;
      padding: 0 14px;
      border: 1px solid var(--accent-line);
      border-radius: var(--radius-s);
      background: var(--accent-soft);
      color: var(--accent);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    #board-hint button[hidden] { display: none; }
    /* Board layout switcher: Groups, Status or Map, shown only on the board. */
    #board-modes {
      position: fixed;
      left: 50%;
      bottom: 32px;
      z-index: 12;
      display: none;
      gap: 4px;
      padding: 4px;
      transform: translateX(-50%);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--radius-m);
      background: var(--bg-panel);
    }
    body.flat-board:not(.collection-mode) #board-modes { display: flex; }
    #board-modes button {
      min-height: 44px;
      padding: 0 16px;
      border: 1px solid transparent;
      border-radius: var(--radius-s);
      background: none;
      color: #8a93a6;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    #board-modes button[aria-pressed="true"] { border-color: var(--accent-line); background: var(--active-fill); color: #fff; }
    .board-header.renamable { pointer-events: auto; cursor: text; }
    .board-header.renamable:hover { border-color: var(--accent-line); }
    .board-header input {
      width: 14ch;
      padding: 0;
      border: 0;
      border-bottom: 1px solid var(--accent-line);
      background: transparent;
      color: #fff;
      font: inherit;
      outline: none;
    }
    @media (max-width: 767px) {
      #board-modes { bottom: max(12px, env(safe-area-inset-bottom)); }
      body.card-open #board-modes, body.card-open #board-hint { display: none !important; }
      #board-hint { bottom: 80px; }
    }
    body.board-card-dragging, body.board-card-dragging * { cursor: grabbing !important; }
    /* Gallery arrows: translucent, side by side in the dark space below the wall, centred in the open area between the
       sidebars. The page places them every frame while the gallery is open. */
    #gallery-nav[hidden], body.collection-mode #gallery-nav { display: none; }
    #gallery-nav button {
      position: fixed;
      z-index: 12;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: var(--radius-m);
      background: rgba(8,12,20,0.45);
      color: rgba(223,253,247,0.85);
      cursor: pointer;
      /* left and top follow the free area (placed from script) and ease with the panels when Atomic opens or closes. */
      transition: transform 300ms cubic-bezier(0.25, 1, 0.5, 1), background 300ms cubic-bezier(0.25, 1, 0.5, 1), left 0.3s ease, top 0.3s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      #gallery-nav button { transition: none; }
    }
    #gallery-nav button:hover, #gallery-nav button:focus-visible { background: rgba(8,12,20,0.7); border-color: var(--accent-line); color: #fff; outline: none; }
    #gallery-nav button:active { transform: scale(0.98); transition-duration: 0s; }
    #cluster-drawer .drawer-head { display: flex; align-items: center; gap: 8px; padding-right: 24px; }
    #cluster-drawer .drawer-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
    #cluster-drawer h3 { margin: 0; font-size: 15px; color: var(--accent); text-transform: capitalize; }
    #cluster-drawer .drawer-count { color: #8a93a6; font-size: 11px; }
    #cluster-drawer .card-close {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 10;
      background: none;
      border: none;
      color: #8a93a6;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
    }
    #cluster-drawer .card-close:hover { color: var(--accent); }
    #cluster-cards { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .mini-card {
      position: relative;
      isolation: isolate;
      appearance: none;
      text-align: left;
      width: 100%;
      padding: 10px 12px;
      border-radius: var(--radius-s);
      border: var(--hairline);
      background: var(--bg-raised);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .mini-card:hover { border-color: rgba(0,255,204,0.45); background: rgba(0,255,204,0.07); }
    /* Mirrors a hovered 3D node; declared before .active so the selected card wins. */
    .mini-card.hover { border-color: #22d3ee; background: rgba(30,41,59,0.8); }
    .mini-card.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    /* Keep the node card clear of the drawer so both stay usable side by side. */
    #node-card .card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; padding-right: 72px; }
    #node-card .card-head .card-tag { margin-bottom: 0; }
    .card-carousel { display: inline-flex; align-items: center; gap: 6px; }
    .card-carousel[hidden] { display: none; }
    .card-to-deck { appearance: none; padding: 2px 9px; border-radius: var(--radius-s); border: 1px solid rgba(0,255,204,0.35); background: rgba(0,255,204,0.08); color: #dffdf7; font-size: 11px; cursor: pointer; }
    .card-to-deck:hover, .card-to-deck:focus-visible { background: rgba(0,255,204,0.2); outline: none; }
    body.carousel-mode .card-to-deck { display: none; }
    .carousel-btn {
      width: 26px;
      height: 26px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-s);
      border: 1px solid rgba(0,255,204,0.45);
      background: rgba(0,255,204,0.08);
      color: var(--accent);
      font-size: 17px;
      line-height: 1;
      cursor: pointer;
    }
    .carousel-btn:hover, .carousel-btn:focus-visible { background: rgba(0,255,204,0.2); outline: none; }
    .card-counter { font-size: 11px; color: #aab3c5; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .card-handle { display: none; }
    /* Desktop / laptop: the node card is the right sidebar, full height below the toolbars. */
    @media (min-width: 768px) {
      #node-card { left: auto; right: 12px; top: 102px; bottom: auto; width: clamp(340px, 27vw, 420px); max-height: calc(100vh - 122px); }
    }
    /* The details panel eases in from its edge as the camera moves to the card (the right side on desktop, up from the
       bottom on phones), instead of appearing at once. It animates the translate property, not transform, so the phone
       sheet's drag (an inline transform) is untouched; getCardCover reads the panel's resting place. */
    body.card-open #node-card { animation: node-card-in 0.3s ease; }
    @keyframes node-card-in { from { translate: 24px 0; opacity: 0; } to { translate: 0 0; opacity: 1; } }
    @media (max-width: 767px) {
      @keyframes node-card-in { from { translate: 0 24px; opacity: 0; } to { translate: 0 0; opacity: 1; } }
    }
    @media (prefers-reduced-motion: reduce) {
      body.card-open #node-card { animation: none; }
    }
    @media (min-width: 1100px) {
      body.collection-mode.card-open #collection-view { padding-right: 450px; padding-bottom: 24px; }
    }
    /* Phones: the node card is the one bottom sheet. It opens at a peek height so the 3D view keeps about three
       quarters of the screen; swiping its handle up (or tapping it) expands it to the full details, down collapses
       it and then closes it. While a card is open the group list and the filter row step aside. */
    @media (max-width: 767px) {
      #node-card { left: 6px; right: 6px; bottom: 0; max-height: 24vh; padding-top: 24px; border-radius: var(--radius-m) var(--radius-m) 0 0; border-bottom: none; transition: max-height 300ms cubic-bezier(0.25, 1, 0.5, 1); }
      #node-card.expanded { max-height: 78vh; }
      #node-card:not(.expanded) #card-preview-image,
      #node-card:not(.expanded) #card-carousel,
      #node-card:not(.expanded) #card-to-deck { display: none !important; }
      body.card-open #cluster-drawer,
      body.card-open #filter-toolbar,
      body.card-open #gallery-nav { display: none !important; }
      #node-card.dragging { transition: none; }
      #node-card.settling { transition: transform 0.2s ease; }
      .card-handle {
        display: block;
        position: absolute;
        /* Above the header chips, whose 44pt hit areas reach up into the handle strip. */
        z-index: 3;
        top: 0;
        left: 25%;
        right: 25%;
        height: 22px;
        cursor: grab;
      }
      .card-handle::before {
        content: '';
        position: absolute;
        top: 8px;
        left: 50%;
        width: 40px;
        height: 4px;
        margin-left: -20px;
        border-radius: 2px;
        background: rgba(255,255,255,0.3);
      }
    }
    .mini-card strong { display: block; font-size: 12px; color: #fff; line-height: 1.3; margin-bottom: 4px; }
    .mini-card span { display: block; font-size: 11px; color: #8a93a6; line-height: 1.35; word-break: break-word; }
    .mini-card a { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 700; color: var(--accent); text-decoration: none; }
    #cluster-drawer .ask-box { margin-top: 0; }
    #node-card h3 { padding-right: 56px; margin: 0 0 6px 0; font-size: 15px; color: var(--accent); line-height: 1.3; }
    #node-card p { margin: 0 0 12px 0; font-size: 13px; color: #ccc; word-break: break-word; line-height: 1.4; }
    #node-card .card-tag {
      display: inline-block;
      margin-bottom: 8px;
      padding: 3px 7px;
      border-radius: 4px;
      border: 1px solid rgba(0,255,204,0.45);
      background: rgba(0,255,204,0.1);
      color: var(--accent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    #node-card .card-meta { font-size: 11px; color: #8a93a6; }
    #node-card a {
      display: inline-block;
      background: var(--accent);
      color: #0b0f19;
      padding: 8px 14px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
      font-size: 12px;
    }
    /* Link buttons (video pipeline phase 1): a compact play button for videos that play inside Aether, a quiet launch
       arrow for everything else. 36px visible, 44pt hit area. */
    .link-action {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 36px;
      height: 36px;
      padding: 0;
      border-radius: var(--radius-s);
      font-size: 15px;
      font-weight: 700;
      line-height: 1;
      text-decoration: none;
      cursor: pointer;
    }
    .link-action::after { content: ''; position: absolute; inset: -4px; }
    .link-action.play { border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); }
    .link-action.launch { border: 1px solid rgba(255,255,255,0.12); background: var(--bg-raised); color: #8a93a6; }
    .link-action.launch:hover, .link-action.launch:focus-visible { border-color: var(--accent-line); color: var(--accent); outline: none; }
    #node-card a.link-action, .mini-card a.link-action, .item-foot a.link-action { display: inline-flex; padding: 0; border-radius: var(--radius-s); }
    #node-card a.link-action.play { background: var(--accent); color: var(--on-accent); }
    #node-card a.link-action.launch { background: var(--bg-raised); color: #8a93a6; }
    .link-action svg { width: 14px; height: 14px; }
    .mini-card .link-action, .item-foot .link-action { width: 32px; height: 32px; margin-top: 6px; }
    .item-foot .link-action { margin: 0 0 0 auto; }
    /* The inline player, pinned over the focused card (or centred when there is no card on screen). */
    /* On a card it takes the place of the card's thumbnail: its corners follow the thumbnail's (--media-radius, set per
       frame from the card's size) and it has no border, the card's frame being round it. An iframe is its own
       compositing layer and can ignore a parent's rounded clip, so the frame and the player inside are rounded and
       clipped too. */
    #media-player {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 12;
      overflow: hidden;
      isolation: isolate;
      border: 1px solid var(--accent-line);
      border-radius: var(--media-radius, var(--radius-m));
      clip-path: inset(0 round var(--media-radius, var(--radius-m)));
      background: #000;
    }
    #media-player[hidden] { display: none; }
    #media-player.on-card { border-color: transparent; }
    #media-frame, #media-frame iframe, #media-frame video { display: block; width: 100%; height: 100%; border: 0; background: #000; }
    #media-frame, #media-frame iframe, #media-frame video {
      overflow: hidden;
      border-radius: max(0px, calc(var(--media-radius, var(--radius-m)) - 1px));
      clip-path: inset(0 round max(0px, calc(var(--media-radius, var(--radius-m)) - 1px)));
    }
    #media-frame video { object-fit: contain; }
    #media-close {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 36px;
      height: 36px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: var(--radius-s);
      background: rgba(8,12,20,0.75);
      color: #fff;
      font-size: 18px;
      cursor: pointer;
    }
    #legend {
      position: absolute;
      bottom: 20px;
      left: 15px;
      z-index: 9;
      min-width: 150px;
      max-height: 45vh;
      overflow-y: auto;
      padding: 10px 12px;
      border-radius: var(--radius-m);
      background: var(--bg-panel);
      border: var(--hairline);
      color: #dffdf7;
      font-size: 11px;
    }
    #legend .legend-title {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      font-size: 10px;
      letter-spacing: 0.08em;
      color: #8a93a6;
      text-transform: uppercase;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    #legend .legend-title::-webkit-details-marker { display: none; }
    #legend .legend-title::before { content: '▸'; font-size: 11px; transition: transform 0.15s; }
    #legend[open] .legend-title::before { transform: rotate(90deg); }
    #legend[open] .legend-title { margin-bottom: 6px; }
    #legend:not([open]) { min-width: 0; }
    #legend .legend-item {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      margin: 2px 0;
      padding: 4px 6px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font-size: 11px;
      cursor: pointer;
      text-align: left;
    }
    #legend .legend-item:hover { background: rgba(255,255,255,0.06); }
    #legend .legend-item.active { border-color: rgba(0,255,204,0.55); background: rgba(0,255,204,0.1); }
    #legend .legend-item.dimmed { opacity: 0.45; }
    #legend .legend-badge { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    #legend .legend-name { flex: 1; }
    #legend .legend-count { color: #8a93a6; font-variant-numeric: tabular-nums; }
    #legend .legend-active { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; background: var(--accent); color: var(--on-accent); font-size: 10px; font-weight: 700; letter-spacing: 0; }
    #legend .legend-active[hidden] { display: none; }
    /* Phones: the category list is a compact pill in the corner (a count badge shows how many are highlighted); open, it
       is one row of category chips just above the pill, scrolled sideways, clear of the control wheel. */
    @media (max-width: 767px) {
      #legend {
        left: 10px;
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        min-width: 0;
        max-width: calc(100vw - 196px);
        max-height: none;
        overflow: visible;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
      }
      #legend .legend-title {
        width: max-content;
        height: 34px;
        padding: 0 12px;
        box-sizing: border-box;
        border: var(--hairline);
        border-radius: 17px;
        background: var(--bg-panel);
        color: #aab3c5;
      }
      #legend[open] .legend-title { margin-bottom: 0; border-color: var(--accent-line); color: var(--accent); }
      #legend .legend-hint { display: none; }
      #legend-items {
        position: absolute;
        left: 0;
        bottom: calc(100% + 6px);
        display: flex;
        gap: 6px;
        width: calc(100vw - 196px);
        padding: 1px 0;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-mask-image: linear-gradient(to right, #000 82%, transparent);
        mask-image: linear-gradient(to right, #000 82%, transparent);
      }
      #legend-items::-webkit-scrollbar { display: none; }
      #legend .legend-item {
        flex: none;
        width: auto;
        height: 32px;
        margin: 0;
        padding: 0 11px;
        gap: 6px;
        border: var(--hairline);
        border-radius: 16px;
        background: var(--bg-panel);
        white-space: nowrap;
      }
      #legend .legend-item:last-child { margin-right: 28px; }
      #legend .legend-item.active { border-color: var(--accent); background: #0c2a2a; color: var(--accent); }
      #legend .legend-item.active .legend-count { color: var(--accent); }
      #legend .legend-item.dimmed { opacity: 0.6; }
      #legend .legend-badge { width: 8px; height: 8px; }
    }
    /* Tablets and small laptops: icon-only Telegram and view buttons (tooltips keep the names), so the search
       box keeps its room and the top bar never scrolls. */
    @media (max-width: 900px) {
      #telegram-help-button .bar-label, #view-switch .view-label { display: none; }
      #telegram-help-button { padding: 0 10px; }
      #view-switch button { padding: 0 9px; }
    }
    @media (max-width: 600px) {
      #topbar .brand, #topbar .user-greeting { display: none; }
      #topbar { gap: 6px; padding: 0 7px; }
      .bar-btn { padding: 0 10px; }
      .filter-dropdown { position: fixed; top: 100px; left: 10px; right: 10px; width: auto; }
      #cluster-drawer { top: auto; left: 10px; right: 10px; bottom: 12px; width: auto; max-height: 60vh; }
      #cluster-cards { flex: none; flex-direction: row; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; padding-bottom: 4px; }
      .mini-card { flex: 0 0 78%; scroll-snap-align: start; }
      #filter-toolbar { left: 10px; right: 10px; transform: none; max-width: none; }
      #platform-bar { flex: 1 1 auto; }
      .platform-pill { padding: 0 10px; }
      #view-switch .view-label { display: none; }
      /* Phones: short 2D/3D label, and Telegram help moves into the settings menu. */
      #telegram-help-button { display: none; }
      .settings-option.phone-only { display: block; }
      #view-toggle .bar-label { display: none; }
      /* Phones: the slider moves to the filter row (the top bar has no room), with a shorter track and only the chosen
         stop's name. */
      .depth-control { flex: none; padding: 0 8px; }
      .depth-control input[type="range"], .depth-stops { width: 64px; }
      /* Phones get a vertical zoom rail beside the 3D view instead (zoom stops, step 3). */
      .zoom-control { display: none; }
      .depth-stops { justify-content: center; }
      .depth-stops span:not(.active) { display: none; }
      #view-toggle::after { content: attr(data-short); }
      #view-toggle { padding: 0 10px; }
      .command-row { grid-template-columns: 1fr; gap: 2px; }
      #view-switch button { padding: 0 9px; }
      #collection-view { padding: 2px 10px 20px; }
      .collection-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .item-card.list.has-thumb { grid-template-columns: minmax(0, 1fr) 88px; }
      .item-thumb { width: 88px; }
      /* Phones: one column per screen, swiped sideways. */
      .board-view { grid-template-columns: repeat(4, 82vw); scroll-snap-type: x proximity; }
      .board-column { scroll-snap-align: start; }
    }
    /* Top-bar tab to Mission Control (/mission-control), where all Aether_Engine controls live. */
    .mc-tab { text-decoration: none; gap: 6px; }
    .mc-tab:hover, .mc-tab:focus-visible { border-color: var(--accent-line); color: var(--accent); outline: none; }
    @media (max-width: 900px) {
      .mc-tab .bar-label { display: none; }
    }
  </style>
  <!-- Pinned and self-hosted from public/vendor/ (SPATIAL_ARCHITECTURE.md, section 4.2). -->
  <script src="/vendor/3d-force-graph-1.80.0.min.js"></script>
  <script type="module" src="/js/spatial/index.js?v=${assetVersion}"></script>
  <script type="module" src="/js/update-check.js?v=${assetVersion}"></script>
</head>
<body>
  <header id="topbar">
    <span class="brand">Aether Portal</span>
    <span class="user-greeting" id="user-greeting" hidden></span>
    <a class="bar-btn mc-tab" id="mission-control-tab" href="/mission-control" title="Mission Control: Elarion, agent tasks and the circuit breaker" aria-label="Mission Control"><span aria-hidden="true">🛰</span><span class="bar-label">Mission Control</span></a>
    <input type="text" id="search-input" placeholder="🔍 Search nodes...">
    <button type="button" class="bar-btn" id="telegram-help-button" title="Telegram commands" aria-label="Telegram commands" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg><span class="bar-label">Telegram Commands</span></button>
    <span class="bar-spacer"></span>
    <div id="view-switch" role="group" aria-label="View mode">
      <button type="button" data-view="graph" aria-pressed="true" title="Graph view"><span class="view-icon">◉</span><span class="view-label">Graph</span></button>
      <button type="button" data-view="list" aria-pressed="false" title="List and grid view"><span class="view-icon">☰</span><span class="view-label">List</span></button>
      <button type="button" data-view="timeline" aria-pressed="false" title="Timeline view"><span class="view-icon">⏱</span><span class="view-label">Timeline</span></button>
      <button type="button" data-view="board" aria-pressed="false" title="Board view: drag cards between Inbox, Active, Reference and Done"><span class="view-icon">▥</span><span class="view-label">Board</span></button>
      <button type="button" data-view="carousel" aria-pressed="false" title="Carousel view: swipe through cards one at a time"><span class="view-icon">❐</span><span class="view-label">Carousel</span></button>
    </div>
    <div class="depth-control" id="depth-control" title="Connection depth: how far Aether reaches when it links your saves. It shapes the wires, and the Outcomes synthesis proposes.">
      <input type="range" id="depth-slider" min="0" max="2" step="1" value="1" aria-label="Connection depth" aria-valuetext="Logical">
      <div class="depth-stops" aria-hidden="true"><span data-depth="obvious">Obvious</span><span data-depth="logical">Logical</span><span data-depth="abstract">Abstract</span></div>
    </div>
    <div class="zoom-control" id="zoom-control" title="Spatial zoom: Space (everything), Cluster (one group), Horizon (the group's 180° wall), Atomic (one card). The mouse wheel steps between them too.">
      <input type="range" id="zoom-slider" min="0" max="3" step="1" value="2" aria-label="Spatial zoom" aria-valuetext="Zoom">
      <div class="zoom-stops"><span data-stop="space">Space</span><span data-stop="cluster">Cluster</span><span data-stop="horizon">Horizon</span><span data-stop="atomic">Atomic</span></div>
    </div>
    <button class="view-toggle bar-btn" id="view-toggle" data-short="2D" title="Morph between the 3D space and the 2D board"><span class="bar-label">2D Board</span></button>
    <div class="xr-wrap">
      <button class="view-toggle bar-btn" id="xr-button" data-short="XR" title="Step into your graph with a headset" aria-haspopup="menu" hidden><span class="bar-label">Enter XR</span></button>
      <div id="xr-menu" class="xr-menu" role="menu" hidden>
        <button type="button" role="menuitem" data-xr-mode="immersive-ar"><strong>Mixed reality</strong><span>See your room around the graph</span></button>
        <button type="button" role="menuitem" data-xr-mode="immersive-vr"><strong>Virtual reality</strong><span>Dark space, no passthrough</span></button>
      </div>
    </div>
    <button class="bar-btn" id="add-node-button" title="Add node" aria-label="Add node">+</button>
  <div class="settings-wrap">
    <button class="settings-button bar-btn" id="settings-toggle" title="Settings">⚙️</button>
    <div class="settings-menu" id="settings-menu">
      <button class="settings-option" id="recluster-button">⚡ Recluster Graph with AI</button>
      <button class="settings-option" id="backfill-button">🔗 Fetch Titles &amp; Previews for Old Links</button>
      <button class="settings-option" id="synthesize-button">✦ Synthesize Outcomes Now</button>
      <button class="settings-option" id="remine-button">🏷️ Mine Tags &amp; Groups for Old Nodes</button>
      <button class="settings-option" id="clear-filters-button">Clear Filters</button>
      <button class="settings-option phone-only" id="telegram-help-menu-option">✈️ Telegram Commands</button>
      <button class="settings-option phone-only" id="dial-sound-option" hidden>🔈 Wheel clicks: On</button>
      <button class="settings-option" id="display-name-button">✎ Display Name</button>
      <button class="settings-option" id="logout-button">⎋ Sign Out</button>
    </div>
  </div>
  </header>

  <!-- Second toolbar row: one segmented origin control, then the secondary filters popover at its right end. -->
  <div id="filter-toolbar">
    <div id="scope-stepper" role="group" aria-label="Time scope">
      <button type="button" id="scope-narrow" title="Show a shorter time span" aria-label="Show a shorter time span">−</button>
      <span id="scope-label" aria-live="polite">All time</span>
      <button type="button" id="scope-widen" title="Show a longer time span" aria-label="Show a longer time span">+</button>
    </div>
    <nav id="platform-bar" role="group" aria-label="Platform filter">
      <button type="button" class="platform-pill" data-platform="all" aria-pressed="true">All</button>
      <button type="button" class="platform-pill" data-platform="youtube" aria-pressed="false">YouTube</button>
      <button type="button" class="platform-pill" data-platform="x" aria-pressed="false">X/Twitter</button>
      <button type="button" class="platform-pill" data-platform="facebook" aria-pressed="false">Facebook</button>
      <button type="button" class="platform-pill" data-platform="links" aria-pressed="false">Links</button>
      <button type="button" class="platform-pill" data-platform="notes" aria-pressed="false">Notes</button>
      <button type="button" class="platform-pill" data-platform="images" aria-pressed="false">Images</button>
    </nav>
    <details id="filter-menu">
      <summary class="bar-btn" aria-label="Filters">Filters ⚙️<span id="filter-badge" class="filter-badge" hidden></span></summary>
      <div class="filter-dropdown">
        <label class="filter-field"><span>Time</span>
          <select id="time-filter">
            <option value="all">All Time</option>
            <option value="day">Today</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
            <option value="groups">All Time as Groups</option>
          </select>
        </label>
        <label class="filter-field"><span>Category</span>
          <select id="type-filter">
            <option value="all">All Categories</option>
            <option value="link">Links</option>
            <option value="dev_task">Dev Tasks</option>
            <option value="video">Videos</option>
            <option value="note">Notes</option>
            <option value="image">Images</option>
          </select>
        </label>
        <label class="filter-field"><span>Group by</span>
          <select id="group-by">
            <option value="group">Groups</option>
            <option value="category">Category</option>
            <option value="platform">Platform</option>
            <option value="tag">Top tag</option>
          </select>
        </label>
        <div class="filter-field"><span>Graph Colors</span><button type="button" id="cluster-toggle" class="toggle-button active" data-mode="category">Category View</button></div>
        <div class="filter-field"><span>Unlinked Nodes</span><button type="button" id="orphan-toggle" class="toggle-button" aria-pressed="false">Hide Unlinked</button></div>
        <button type="button" id="filters-reset" class="filters-reset">Clear All Filters</button>
      </div>
    </details>
  </div>

  <div id="node-card">
    <button id="card-close" class="card-close" title="Close" aria-label="Close">×</button>
    <button id="card-delete" class="card-delete" title="Delete node" aria-label="Delete node"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
    <div class="card-handle" aria-hidden="true"></div>
    <div class="card-head">
      <span id="card-tag" class="card-tag">NOTE</span>
      <span id="card-group" class="card-group"></span>
      <div id="card-carousel" class="card-carousel" hidden>
        <button type="button" id="card-prev" class="carousel-btn" title="Previous card (←)" aria-label="Previous card in cluster">‹</button>
        <span id="card-counter" class="card-counter" aria-live="polite"></span>
        <button type="button" id="card-next" class="carousel-btn" title="Next card (→)" aria-label="Next card in cluster">›</button>
      </div>
      <button type="button" id="card-to-deck" class="card-to-deck" title="Show this node in Carousel view">❐ Carousel</button>
    </div>
    <div id="card-preview" class="card-preview">
      <img id="card-preview-image" alt="" loading="lazy" referrerpolicy="no-referrer" hidden>
      <div class="card-preview-bar">
        <img id="card-favicon" class="favicon" alt="" referrerpolicy="no-referrer" hidden>
        <span id="card-site" class="card-site"></span>
        <a id="card-link" href="#" target="_blank" rel="noopener noreferrer">🔗 Open Original Source</a>
      </div>
    </div>
    <h3 id="card-title">Node Details</h3>
    <div id="card-note" class="card-note">
      <span class="card-note-label">📝 Your note</span>
      <div id="card-note-text" class="card-note-text"></div>
    </div>
    <p id="card-description" class="card-description"></p>
    <button type="button" id="card-reader-button" class="reader-button">⤢ Expand Full Reader</button>
    <div id="card-transcript" class="card-transcript" hidden>
      <span class="card-transcript-label">🎬 Video synopsis</span>
      <div id="card-synopsis" class="card-synopsis"></div>
      <div class="card-transcript-actions">
        <button type="button" id="card-transcript-button">🎬 Get Transcript</button>
        <button type="button" id="card-transcript-read" hidden>⤢ Read Transcript</button>
        <span id="card-transcript-status" class="card-transcript-status" aria-live="polite"></span>
      </div>
    </div>
    <div id="card-outcome" class="card-outcome" hidden>
      <div class="card-outcome-head">
        <span class="card-outcome-badge">OUTCOME ✦</span>
        <span id="card-outcome-meta" class="card-outcome-meta"></span>
      </div>
      <p id="card-outcome-goal" class="card-outcome-goal"></p>
      <ol id="card-outcome-steps" class="card-outcome-steps"></ol>
      <div class="card-outcome-actions">
        <button type="button" id="outcome-accept">Accept</button>
        <button type="button" id="outcome-regenerate">Regenerate</button>
        <button type="button" id="outcome-export">Export blueprint</button>
        <a id="outcome-mission-control" class="card-outcome-link" href="/mission-control#blueprints" title="Load this blueprint into Mission Control to compile it on the Aether Engine">Open in Mission Control</a>
        <button type="button" id="outcome-dismiss">Dismiss</button>
      </div>
      <span id="card-outcome-message" class="card-outcome-message" aria-live="polite"></span>
    </div>
    <div id="card-web" class="card-web" hidden>
      <div class="card-transcript-actions">
        <button type="button" id="card-web-button">🌐 Fetch Web Content</button>
        <button type="button" id="card-web-read" hidden>⤢ Read Web Content</button>
        <span id="card-web-status" class="card-transcript-status" aria-live="polite"></span>
      </div>
    </div>
    <p id="card-meta" class="card-meta"></p>
    <div id="card-links" class="card-links" hidden>
      <span class="card-links-label">Connections</span>
      <ul id="card-links-list" class="card-links-list"></ul>
      <span id="card-links-status" class="card-links-status" aria-live="polite"></span>
    </div>
    <button type="button" id="card-link-button" class="card-link-button" title="Connect this node to another">🔗 Link to…</button>
    <div id="card-status" class="card-status" role="group" aria-label="Board column"><span class="card-status-label">Board</span></div>
    <div class="ask-box">
      <div class="ask-row">
        <textarea id="card-ask-input" rows="1" maxlength="1000" placeholder="Ask Elarion about this node"></textarea>
        <button id="card-ask-button">Ask</button>
      </div>
      <div id="card-ask-answer" class="ask-answer"></div>
      <button type="button" id="card-spawn-button" class="spawn-button">+ Create Node from Answer</button>
    </div>
    <details id="card-research" class="card-research">
      <summary id="card-research-summary">Past Research &amp; Q&amp;A</summary>
      <div id="card-research-list" class="card-research-list"></div>
    </details>
  </div>

  <aside id="cluster-drawer" aria-label="Cluster reader">
    <button id="drawer-close" class="card-close" title="Close" aria-label="Close">×</button>
    <div class="drawer-head">
      <span id="drawer-dot" class="drawer-dot"></span>
      <h3 id="drawer-title">Cluster</h3>
      <span id="drawer-count" class="drawer-count"></span>
    </div>
    <div id="cluster-cards"></div>
    <div class="ask-box">
      <div class="ask-row">
        <textarea id="drawer-ask-input" rows="2" maxlength="1000" placeholder="Ask Elarion about this cluster"></textarea>
        <button id="drawer-ask-button">Ask</button>
      </div>
      <div id="drawer-ask-answer" class="ask-answer"></div>
    </div>
  </aside>

  <div id="login-gate" hidden>
    <div class="login-panel" role="dialog" aria-modal="true" aria-labelledby="login-title">
      <img class="login-logo" src="/icons/icon-192.png" alt="" width="64" height="64">
      <h2 id="login-title">Aether Portal</h2>
      <p class="login-sub">Your knowledge, mapped in three dimensions.</p>
      <a id="google-signin" class="google-button" href="/api/auth/google">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        <span>Sign in with Google</span>
      </a>
      <a id="dev-signin" class="google-button dev-button" href="/api/auth/dev" hidden>Dev Operator Login</a>
      <p id="login-error" class="login-error" role="alert"></p>
    </div>
  </div>

  <div id="telegram-help-modal" class="modal-backdrop" hidden>
    <article class="reader-panel help-panel" role="dialog" aria-modal="true" aria-labelledby="telegram-help-title">
      <button type="button" id="telegram-help-close" class="card-close" title="Close" aria-label="Close">×</button>
      <h3 id="telegram-help-title">✈️ Telegram Commands</h3>
      <p class="reader-meta">Save and research from anywhere by messaging your Aether bot.</p>
      <div class="reader-body">
      ${renderTelegramHelpHtml()}
      </div>
    </article>
  </div>

  <div id="reader-modal" class="modal-backdrop" hidden>
    <article class="reader-panel" role="dialog" aria-modal="true" aria-labelledby="reader-title">
      <button type="button" id="reader-close" class="card-close" title="Close" aria-label="Close">×</button>
      <h3 id="reader-title"></h3>
      <p id="reader-meta" class="reader-meta"></p>
      <div id="reader-body" class="reader-body"></div>
      <a id="reader-link" href="#" target="_blank" rel="noopener noreferrer">🔗 Open Original Source</a>
    </article>
  </div>

  <div id="add-node-modal" class="modal-backdrop" hidden>
    <form id="add-node-form" class="modal-panel" autocomplete="off">
      <h3>Add Node</h3>
      <label>Title
        <input id="add-node-title" type="text" required maxlength="200">
      </label>
      <label>Category
        <select id="add-node-category"></select>
      </label>
      <label>Content
        <textarea id="add-node-content" rows="4" maxlength="5000" placeholder="Note body (optional)"></textarea>
      </label>
      <label>Connect To
        <select id="add-node-link"></select>
      </label>
      <p id="add-node-error" class="modal-error"></p>
      <div class="modal-actions">
        <button type="button" id="add-node-cancel" class="toggle-button">Cancel</button>
        <button type="submit" id="add-node-submit" class="toggle-button active">Create Node</button>
      </div>
    </form>
  </div>

  <div id="link-node-modal" class="modal-backdrop" hidden>
    <form id="link-node-form" class="modal-panel" autocomplete="off">
      <h3>Link Node</h3>
      <p id="link-node-source" class="card-meta"></p>
      <label>Link To
        <select id="link-node-target" required></select>
      </label>
      <label>Relationship
        <input id="link-node-relation" type="text" maxlength="80" placeholder="e.g. inspired by (optional)">
      </label>
      <p id="link-node-error" class="modal-error"></p>
      <div class="modal-actions">
        <button type="button" id="link-node-pick" class="toggle-button" title="Close this and tap the card to link to">Pick on graph</button>
        <button type="button" id="link-node-cancel" class="toggle-button">Cancel</button>
        <button type="submit" id="link-node-submit" class="toggle-button active">Link</button>
      </div>
    </form>
  </div>
  <div id="link-pick-hint" role="status" hidden><span id="link-pick-text"></span><button type="button" id="link-pick-cancel" class="toggle-button">Cancel</button></div>

  <details id="legend" open>
    <summary class="legend-title"><span class="legend-label">Categories</span><span class="legend-hint"> · tap to highlight</span><span id="legend-active" class="legend-active" hidden></span></summary>
    <div id="legend-items"></div>
  </details>

  <div id="3d-graph" style="width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;"></div>
  <div id="thumb-wheel"><div class="wheel-actions"><button type="button" id="wheel-home" title="Home: recentre the current view (Home or H)" aria-label="Recentre view"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.4 8 2.8l5.5 4.6M4.2 6.2V13h2.9V9.6h1.8V13h2.9V6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg><span>Home</span></button><button type="button" id="wheel-mode" role="switch" aria-checked="true" title="Wheel mode: Advanced shows every ring; Simple keeps to the view and its main ring"><span class="wheel-mode-track"><span class="wheel-mode-knob"></span></span><span class="wheel-mode-label">Advanced</span></button></div></div>
  <div id="media-player" hidden>
    <div id="media-frame"></div>
    <button type="button" id="media-close" title="Close video" aria-label="Close video">×</button>
  </div>
  <div id="board-headers" hidden></div>
  <div id="board-hint" role="status" hidden><span id="board-hint-text"></span><button type="button" id="board-hint-undo" hidden>Undo</button></div>
  <div id="board-modes" role="group" aria-label="Board layout">
    <button type="button" data-board-mode="groups" aria-pressed="true" title="A column per group">Groups</button>
    <button type="button" data-board-mode="status" aria-pressed="false" title="Inbox, Active, Reference and Done">Status</button>
    <button type="button" data-board-mode="map" aria-pressed="false" title="A node map wired along the connections">Map</button>
    <button type="button" data-board-mode="timeline" aria-pressed="false" title="Cards in date order, a column per day, week or month">Timeline</button>
  </div>
  <div id="gallery-nav" hidden>
    <button type="button" id="gallery-prev" title="Previous card (swipe right)" aria-label="Previous card"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2.5 3.5 8 11 13.5z" fill="currentColor"/></svg></button>
    <button type="button" id="gallery-next" title="Next card (swipe left)" aria-label="Next card"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5 12.5 8 5 13.5z" fill="currentColor"/></svg></button>
  </div>
  <main id="collection-view" aria-label="Node collection">
    <div class="collection-inner">
      <div id="collection-toolbar">
        <span id="collection-count"></span>
        <select id="collection-sort" aria-label="Sort nodes">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="title">Title A–Z</option>
          <option value="category">Category</option>
        </select>
        <span id="layout-pills" class="filter-row" role="group" aria-label="Layout">
          <button type="button" class="filter-pill" data-layout="list">☰ List</button>
          <button type="button" class="filter-pill" data-layout="grid">▦ Grid</button>
        </span>
      </div>
      <div id="collection-items"></div>
    </div>
  </main>

  <script>
    const ADMIN_TOKEN_KEY = 'aetherAdminToken';

    const filterState = {
      type: 'all',
      horizon: 'all',
      query: '',
      clusterMode: 'category',
      // 2D board (Phase 5): the cards morph onto a flat board; the camera faces it head-on.
      flat: false,
      // How the board lays the cards out: 'groups' (a column per group), 'status' (Inbox, Active, Reference, Done) or
      // 'map' (a node-editor map wired along the links); remembered per browser.
      boardMode: 'groups',
      // Connection Depth: 'obvious', 'logical' or 'abstract'. Saved on the server (the nightly synthesis reads it) and
      // loaded with the graph.
      depth: 'logical',
      // Hide nodes with no edges among the currently visible nodes.
      hideOrphans: false,
      // Categories highlighted from the legend; empty means everything is shown at full color.
      highlighted: new Set(),
      // Platform bar: 'all' or one platform; the graph dims the rest, list and timeline show only matches.
      platform: 'all',
      // Active view (graph, list, timeline, board or carousel) and the list view's layout and sort; remembered per browser.
      view: 'graph',
      listLayout: 'list',
      listSort: 'newest',
      // What the graph clusters by (SPATIAL_ARCHITECTURE.md 1.7): 'group' (AI and user groups), 'category',
      // 'platform' or 'tag'; remembered per browser.
      groupBy: 'group'
    };

    const VIEW_PREFS_KEY = 'aetherViewPrefs';
    const VIEW_MODES = ['graph', 'list', 'timeline', 'board', 'carousel'];
    const LIST_LAYOUTS = ['list', 'grid'];
    const LIST_SORTS = ['newest', 'oldest', 'title', 'category'];
    const GROUP_BY_KEYS = ['group', 'category', 'platform', 'tag'];
    const BOARD_MODES = ['groups', 'status', 'map', 'timeline'];
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || '{}') || {};
      if (VIEW_MODES.includes(saved.view)) filterState.view = saved.view;
      if (LIST_LAYOUTS.includes(saved.listLayout)) filterState.listLayout = saved.listLayout;
      if (LIST_SORTS.includes(saved.listSort)) filterState.listSort = saved.listSort;
      if (GROUP_BY_KEYS.includes(saved.groupBy)) filterState.groupBy = saved.groupBy;
      if (BOARD_MODES.includes(saved.boardMode)) filterState.boardMode = saved.boardMode;
    } catch (err) {}
    const saveViewPrefs = () => {
      try {
        localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify({ view: filterState.view, listLayout: filterState.listLayout, listSort: filterState.listSort, groupBy: filterState.groupBy, boardMode: filterState.boardMode }));
      } catch (err) {}
    };

    const CATEGORY_COLORS = {
      note: '#8ecae6',
      general: '#94a3b8',
      link: '#4f84ff',
      article: '#00ffcc',
      video: '#ff4d6d',
      dev_task: '#ffd166',
      monetization: '#7ae582',
      ai_tool: '#c77dff',
      marketing: '#ff9f1c',
      route_plan: '#f15bb5',
      image: '#4cc9f0'
    };
    const CATEGORY_ORDER = Object.keys(CATEGORY_COLORS);
    const BOARD_COLUMNS = [
      { status: 'inbox', label: 'Inbox', icon: '📥', color: '#8ecae6' },
      { status: 'active', label: 'Active', icon: '⚡', color: '#ffd166' },
      { status: 'reference', label: 'Reference', icon: '📚', color: '#c77dff' },
      { status: 'done', label: 'Done', icon: '✅', color: '#7ae582' }
    ];
    const NODE_STATUSES = BOARD_COLUMNS.map(column => column.status);
    const getNodeStatus = node => NODE_STATUSES.includes(node.status) ? node.status : 'inbox';
    const FALLBACK_CATEGORY_COLOR = '#cccccc';
    const DIM_NODE_COLOR = 'rgba(90, 100, 120, 0.18)';
    const DIM_LINK_COLOR = 'rgba(90, 100, 120, 0.06)';
    const MINED_LINK_COLOR = 'rgba(255, 209, 102, 0.75)';
    const DEFAULT_LINK_COLOR = 'rgba(255, 255, 255, 0.2)';
    // Outcome Nodes (SPATIAL_ARCHITECTURE.md section 8) are Outcome Gold everywhere; kept out of CATEGORY_COLORS so the
    // category island slots (CATEGORY_ORDER) do not shift.
    const OUTCOME_COLOR = '#ffb627';
    const getCategoryColor = category => CATEGORY_COLORS[category] || (category === 'outcome' ? OUTCOME_COLOR : FALLBACK_CATEGORY_COLOR);

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

    const getNodeCategory = node => String((node.category || node.type || node.group || 'note')).toLowerCase();

    // The graph library replaces link endpoints with node objects once it has processed them.
    const linkEndId = end => (end && typeof end === 'object') ? end.id : end;

    const getNodeHue = node => {
      const seedString = String(node.id || node.title || node.name || node.url || node.category || 'seed');
      let hash = 0;
      for (let i = 0; i < seedString.length; i++) {
        hash = (hash * 31 + seedString.charCodeAt(i)) >>> 0;
      }
      return hash % 360;
    };

    const getRainbowColor = node => 'hsl(' + getNodeHue(node) + ', 80%, 60%)';

    // Where a node came from, for the platform bar: a photo, a note (no link), a known social site, or any other link.
    const getPlatform = node => {
      if (getNodeCategory(node) === 'image') return 'images';
      const url = String(node.url || '');
      if (!/^https?:/i.test(url)) return 'notes';
      const host = getHostname(url).toLowerCase();
      const onDomain = domains => domains.some(domain => host === domain || host.endsWith('.' + domain));
      if (onDomain(['youtube.com', 'youtu.be'])) return 'youtube';
      if (onDomain(['x.com', 'twitter.com'])) return 'x';
      if (onDomain(['facebook.com', 'fb.watch', 'fb.com'])) return 'facebook';
      return 'links';
    };
    const matchesPlatform = node => filterState.platform === 'all' || getPlatform(node) === filterState.platform;

    // Clusters (SPATIAL_ARCHITECTURE.md 1.7): each visible node's island, from the Group by setting through the
    // spatial grouping engine. Until the spatial modules load, and for nodes with no group or tag, a node's cluster is
    // its category, so an ungrouped graph keeps its category islands.
    let clusterOf = new Map();
    let clusterInfo = new Map();
    const getClusterKey = node => clusterOf.get(node.id) || ('category:' + getNodeCategory(node));
    const getOutcomeMembers = id => {
      const shown = Graph.graphData().nodes;
      const outcome = shown.find(node => node.id === id);
      if (!outcome) return [];
      const inputs = new Set(outcome.outcome_inputs || []);
      return [outcome, ...shown.filter(node => inputs.has(node.id))];
    };
    const getClusterLabel = key => {
      if (key.startsWith('outcome:')) {
        const outcome = graphData.nodes.find(node => node.id === key.slice('outcome:'.length));
        return 'Outcome: ' + (outcome ? outcome.title : 'plan');
      }
      const info = clusterInfo.get(key);
      return info ? info.label : key.slice(key.indexOf(':') + 1).replace(/_/g, ' ');
    };
    const isAiCluster = key => Boolean(clusterInfo.get(key) && clusterInfo.get(key).source === 'ai');
    const getClusterColor = key => {
      if (key.startsWith('outcome:')) return OUTCOME_COLOR;
      const info = clusterInfo.get(key);
      if (info && info.color) return info.color;
      if (key.startsWith('category:')) return getCategoryColor(key.slice('category:'.length));
      return window.AetherSpatial ? window.AetherSpatial.groupColor(key) : FALLBACK_CATEGORY_COLOR;
    };
    const updateClusters = nodes => {
      if (!window.AetherSpatial) return;
      const groups = new Map((graphData.groups || []).map(group => [group.id, group]));
      const hierarchy = window.AetherSpatial.buildHierarchy(nodes, { key: filterState.groupBy, groups });
      clusterOf = hierarchy.groupOf;
      clusterInfo = hierarchy.groups;
    };
    const isDimming = () => filterState.highlighted.size > 0 || filterState.platform !== 'all';
    // Full color only for nodes that pass both the legend highlight and the platform bar.
    const isHighlighted = node => (filterState.highlighted.size === 0 || filterState.highlighted.has(getNodeCategory(node))) && matchesPlatform(node);

    // Selecting a node focuses its 1-hop neighborhood: everything else fades to FOCUS_DIM_OPACITY.
    const FOCUS_DIM_OPACITY = 0.15;
    const BASE_NODE_OPACITY = 0.75;
    const BASE_LINK_OPACITY = 0.2;
    const focus = { node: null, nodeIds: new Set() };
    // This tab's id for live sync (sent with API writes, so the tab skips its own events).
    const LIVE_CLIENT_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2);
    // Link to… pick mode: { source, relation } while waiting for a tap on the target card (declared early: node clicks read it).
    let linkPick = null;

    // Hover is a lighter layer on top of focus: it only lifts one card and brightens its links.
    const hover = { id: null, source: null };
    const hoverCapable = window.matchMedia('(hover: hover)');

    // While a node is hovered or focused, links not touching it fade to this so the map stays quiet.
    const QUIET_LINK_OPACITY = 0.05;
    // Matched by endpoint id so it holds whether the ends are still ids or already node objects.
    const linkTouches = (link, id) => Boolean(id) && (linkEndId(link.source) === id || linkEndId(link.target) === id);
    const isHoverLink = link => linkTouches(link, hover.id);
    const isFocusLink = link => Boolean(focus.node) && linkTouches(link, focus.node.id);
    const isActiveLink = link => isHoverLink(link) || isFocusLink(link);

    // The graph reads per-element alpha from rgba/hsla colors, so dimming just rewrites the alpha.
    const withAlpha = (color, alpha) => {
      if (color[0] === '#' && color.length === 7) {
        const n = parseInt(color.slice(1), 16);
        return 'rgba(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + alpha + ')';
      }
      if (color.startsWith('hsl(')) return 'hsla(' + color.slice(4, -1) + ', ' + alpha + ')';
      if (color.startsWith('rgba(')) return color.replace(/,[^,]*[)]$/, ', ' + alpha + ')');
      return color;
    };

    const getBaseNodeColor = node => filterState.clusterMode === 'rainbow' ? getRainbowColor(node) : getCategoryColor(getNodeCategory(node));

    const getNodeColor = node => {
      if (focus.node) return focus.nodeIds.has(node.id) ? getBaseNodeColor(node) : withAlpha(getBaseNodeColor(node), FOCUS_DIM_OPACITY);
      if (!isHighlighted(node)) return DIM_NODE_COLOR;
      return getBaseNodeColor(node);
    };

    // three.js is loaded separately (the graph bundle keeps its own copy private); until then nodes stay default spheres.
    let THREE = null;

    // Preview cards (SPATIAL_ARCHITECTURE.md 4.3, D5): every node is a canvas-faced card from
    // public/js/spatial/card-nodes.js, created once three.js and the spatial modules have both loaded (the graph shows
    // its default spheres for that first moment). The page sets each card's targets; the card field animates them.
    let cardField = null;
    // The open 180-degree gallery ({ key, origin, yaw, radius, ids }), or null; see enterGallery below.
    let gallery = null;
    const getOutcomeSources = node => {
      if (getNodeCategory(node) !== 'outcome') return [];
      const labels = [];
      (node.outcome_inputs || []).forEach(id => {
        const input = graphData.nodes.find(item => item.id === id);
        if (!input) return;
        const label = getClusterLabel(getClusterKey(input));
        if (!labels.includes(label)) labels.push(label);
      });
      return labels;
    };
    const getCardFace = node => window.AetherSpatial.faceFromNode(node, {
      categoryColor: getBaseNodeColor(node),
      categoryLabel: getNodeCategory(node),
      group: getNodeGroup(node),
      sources: getOutcomeSources(node)
    });
    // Hub weighting (SPATIAL_ARCHITECTURE.md 2.9, D9): how connected each visible card is, relative to what is on
    // screen; recomputed with the filters. node.__hub is the hero scale the collision force reads.
    let hubWeights = new Map();
    const updateHubWeights = (nodes, links) => {
      if (!window.AetherSpatial) return;
      hubWeights = window.AetherSpatial.computeHubWeights(nodes, links);
      // Outcome Nodes (SPATIAL_ARCHITECTURE.md section 8) are always the top hub.
      nodes.forEach(node => { if (getNodeCategory(node) === window.AetherSpatial.OUTCOME_CATEGORY) hubWeights.set(node.id, 1); });
      nodes.forEach(node => { node.__hub = window.AetherSpatial.hubScale(hubWeights.get(node.id) || 0); });
    };
    // heat: 1 focused, 0.5 hovered; dim: outside the focused neighbourhood, or filtered out by the legend or platform bar.
    // In the gallery the arc is the context: the focused card is lit, the rest of its cluster stays readable (slightly
    // subdued while a card is focused) and every card off the arc recedes.
    const getGalleryDim = node => {
      if (!gallery.ids.has(String(node.id))) return 1;
      return focus.node && focus.node.id !== node.id ? 0.15 : 0;
    };
    // The card whose video is playing inline on the wall (Horizon): it stays lifted like a hovered card, so it holds
    // still under its player while the pointer is over the video (and so off the canvas).
    let playingCardId = null;
    const getCardTargets = node => ({
      heat: focus.node && focus.node.id === node.id ? 1 : hover.id === node.id || String(node.id) === playingCardId ? 0.5 : 0,
      dim: gallery ? getGalleryDim(node) : focus.node ? (focus.nodeIds.has(node.id) ? 0 : 1) : (isHighlighted(node) ? 0 : 1),
      weight: hubWeights.get(node.id) || 0
    });
    const syncCards = () => {
      if (!cardField) return;
      Graph.graphData().nodes.forEach(node => {
        cardField.setTargets(node.id, getCardTargets(node));
        cardField.setFace(node.id, getCardFace(node));
      });
    };
    const applyNodeHover = () => syncCards();

    // Link ends are ids until the graph has processed the link, then node objects.
    const isNodeObject = end => Boolean(end && typeof end === 'object');

    const getLinkColor = link => {
      const base = link.type === 'synthesis' ? OUTCOME_COLOR : link.type === 'ai' ? MINED_LINK_COLOR : DEFAULT_LINK_COLOR;
      if (isActiveLink(link)) return withAlpha(base, 1);
      // Hover and focus lift the global link opacity to 1, so the quiet fade lives in each link's alpha.
      if (hover.id || focus.node) return withAlpha(base, QUIET_LINK_OPACITY);
      return isDimming() && ![link.source, link.target].some(end => isNodeObject(end) && isHighlighted(end)) ? DIM_LINK_COLOR : base;
    };

    const isSameClusterLink = link => isNodeObject(link.source) && isNodeObject(link.target) &&
      getClusterKey(link.source) === getClusterKey(link.target);

    // Each category gets a fixed anchor on a sphere; a weak pull toward it turns categories into separate islands.
    // The sphere is at least CLUSTER_RADIUS, and larger when needed so neighbouring anchors sit two cluster radii
    // plus CLUSTER_MARGIN apart (never less than MIN_CLUSTER_GAP), sized for the largest visible category.
    const CLUSTER_RADIUS = 220;
    const MIN_CLUSTER_GAP = 240;
    const CLUSTER_MARGIN = 60;
    const SPHERE_STEP = 40;
    // Measured outer radius of a settled cluster of n nodes: about 100 at 10 nodes, 180 at 100, 230 at 200.
    const estimateClusterRadius = count => 60 + 12 * Math.sqrt(count);
    let clusterGap = MIN_CLUSTER_GAP;
    const CLUSTER_STRENGTH = 0.06;
    // Category clusters keep their fixed slots; other clusters (groups, tags, platforms) take the next free slot in the
    // order they first appear, so adding one never moves the others.
    const clusterIndexes = new Map();
    let extraClusters = 0;
    const getClusterIndex = key => {
      if (!clusterIndexes.has(key)) {
        const known = key.startsWith('category:') ? CATEGORY_ORDER.indexOf(key.slice('category:'.length)) : -1;
        clusterIndexes.set(key, known >= 0 ? known : CATEGORY_ORDER.length + extraClusters++);
      }
      return clusterIndexes.get(key);
    };
    // Slots on the anchor sphere: exactly the categories until other clusters exist, then rounded up in eights so a
    // new group rarely changes the total (which would shift every anchor).
    const getSlotTotal = () => extraClusters
      ? Math.ceil((CATEGORY_ORDER.length + extraClusters) / 8) * 8
      : CATEGORY_ORDER.length;
    // A saved group replaces its temporary id; it keeps the slot it was given while the save was in flight.
    const renameClusterSlot = (fromKey, toKey) => {
      if (!clusterIndexes.has(fromKey)) return;
      clusterIndexes.set(toKey, clusterIndexes.get(fromKey));
      clusterIndexes.delete(fromKey);
    };

    // Fibonacci sphere: unit points spread evenly around the origin.
    const getSpherePoint = (index, total) => {
      const y = 1 - (2 * (index + 0.5)) / total;
      const r = Math.sqrt(1 - y * y);
      const theta = index * Math.PI * (3 - Math.sqrt(5));
      return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
    };
    const closestSpacing = new Map();
    const getSphereRadius = total => {
      if (!closestSpacing.has(total)) {
        const points = Array.from({ length: total }, (_, index) => getSpherePoint(index, total));
        let closest = 2;
        points.forEach((a, i) => points.slice(i + 1).forEach(b => {
          closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }));
        closestSpacing.set(total, closest);
      }
      // Rounded up in steps so small filter changes don't nudge every cluster.
      return Math.max(CLUSTER_RADIUS, Math.ceil(clusterGap / closestSpacing.get(total) / SPHERE_STEP) * SPHERE_STEP);
    };
    const updateClusterSpacing = nodes => {
      const counts = new Map();
      nodes.forEach(node => counts.set(getClusterKey(node), (counts.get(getClusterKey(node)) || 0) + 1));
      const largest = Math.max(0, ...counts.values());
      clusterGap = Math.max(MIN_CLUSTER_GAP, 2 * estimateClusterRadius(largest) + CLUSTER_MARGIN);
    };

    const getClusterAnchor = key => {
      const index = getClusterIndex(key);
      const total = getSlotTotal();
      const point = getSpherePoint(index, total);
      const radius = getSphereRadius(total);
      return { x: point.x * radius, y: point.y * radius, z: point.z * radius };
    };

    const clusterForce = () => {
      let nodes = [];
      let byId = new Map();
      // An Outcome Node sits between the islands it bridges: the average anchor of its inputs' clusters.
      const outcomeAnchor = node => {
        const anchors = (node.outcome_inputs || []).map(id => byId.get(id)).filter(Boolean).map(input => getClusterAnchor(getClusterKey(input)));
        if (!anchors.length) return null;
        return {
          x: anchors.reduce((sum, a) => sum + a.x, 0) / anchors.length,
          y: anchors.reduce((sum, a) => sum + a.y, 0) / anchors.length,
          z: anchors.reduce((sum, a) => sum + a.z, 0) / anchors.length
        };
      };
      const force = alpha => {
        const k = CLUSTER_STRENGTH * alpha;
        nodes.forEach(node => {
          const anchor = (getNodeCategory(node) === 'outcome' && outcomeAnchor(node)) || getClusterAnchor(getClusterKey(node));
          node.vx += (anchor.x - node.x) * k;
          node.vy += (anchor.y - node.y) * k;
          node.vz += (anchor.z - (node.z || 0)) * k;
        });
      };
      force.initialize = initNodes => {
        nodes = initNodes;
        byId = new Map(initNodes.map(node => [node.id, node]));
      };
      return force;
    };

    const matchesTypeFilter = node => {
      const category = getNodeCategory(node);
      switch (filterState.type) {
        case 'all': return true;
        case 'link': return category === 'link' || category === 'article';
        case 'dev_task': return category === 'dev_task';
        case 'video': return category === 'video';
        case 'note': return category === 'note' || category === 'general';
        case 'image': return category === 'image';
        default: return true;
      }
    };

    const isWithinHorizon = (node, horizon) => {
      if (horizon === 'all') return true;
      if (!node.created_at) return true;
      const ts = new Date(node.created_at).getTime();
      if (Number.isNaN(ts)) return true;
      const diffMs = Date.now() - ts;
      const dayMs = 24 * 60 * 60 * 1000;
      switch (horizon) {
        case 'day': return diffMs <= dayMs;
        case 'week': return diffMs <= 7 * dayMs;
        case 'month': return diffMs <= 30 * dayMs;
        default: return true;
      }
    };
    const matchesTimeFilter = node => isWithinHorizon(node, filterState.horizon);

    const matchesSearch = node => {
      if (!filterState.query) return true;
      const haystack = ((node.title || '') + ' ' + (node.url || '') + ' ' + (node.description || '') + ' ' + (node.user_note || '') + ' ' + getNodeCategory(node)).toLowerCase();
      return haystack.includes(filterState.query);
    };

    const safeGraphNode = node => {
      const category = node.category || node.type || node.group || 'note';
      const title = node.title || node.url || 'Untitled Node';
      const created_at = node.created_at || node.createdAt || null;
      return {
        ...node,
        category,
        title,
        name: title,
        group: category,
        type: category,
        created_at,
        url: node.url || '',
        status: NODE_STATUSES.includes(node.status) ? node.status : 'inbox',
        group_id: node.group_id || null,
        group_source: node.group_source || null,
        tags: Array.isArray(node.tags) ? node.tags : []
      };
    };

    const normalizeGraphData = data => {
      const nodes = (data && Array.isArray(data.nodes) ? data.nodes : []).map(safeGraphNode);
      const links = (data && Array.isArray(data.links)) ? data.links : [];
      const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
      return { nodes, links, groups };
    };

    let graphData = { nodes: [], links: [], groups: [] };

    const nodeCard = document.getElementById('node-card');
    const cardStatus = document.getElementById('card-status');
    const legend = document.getElementById('legend');
    const viewSwitch = document.getElementById('view-switch');
    const collectionView = document.getElementById('collection-view');
    const collectionToolbar = document.getElementById('collection-toolbar');
    const collectionCount = document.getElementById('collection-count');
    const collectionSort = document.getElementById('collection-sort');
    const layoutPills = document.getElementById('layout-pills');
    const collectionItems = document.getElementById('collection-items');
    // Nodes that survived the filters on the last applyGraphFilters run; the list and timeline render these.
    let currentVisibleNodes = [];
    let graphLoaded = false;
    const legendItems = document.getElementById('legend-items');
    // Start collapsed on phones so the legend doesn't cover the graph.
    if (window.matchMedia('(max-width: 768px)').matches) legend.open = false;
    // Matches the CSS breakpoint where the node card becomes a bottom sheet.
    const compactLayout = window.matchMedia('(max-width: 767px)');
    // The control wheel (created once the spatial modules load); every control it mirrors calls this when its value
    // changes elsewhere, so the rings turn to match (the headset barrel follows the same values every frame).
    let thumbWheel = null;
    const syncThumbWheel = () => {
      if (thumbWheel) thumbWheel.sync();
    };
    compactLayout.addEventListener('change', () => { FOCUS_FILL = compactLayout.matches ? FOCUS_FILL_COMPACT : FOCUS_FILL_WIDE; });
    const cardTitle = document.getElementById('card-title');
    const cardTag = document.getElementById('card-tag');
    const cardGroup = document.getElementById('card-group');
    const cardDescription = document.getElementById('card-description');
    const cardMeta = document.getElementById('card-meta');
    const cardLink = document.getElementById('card-link');
    const cardPreview = document.getElementById('card-preview');
    const cardPreviewImage = document.getElementById('card-preview-image');
    const cardSite = document.getElementById('card-site');
    const cardFavicon = document.getElementById('card-favicon');
    const cardNote = document.getElementById('card-note');
    const cardNoteText = document.getElementById('card-note-text');
    const cardReaderButton = document.getElementById('card-reader-button');
    const cardTranscript = document.getElementById('card-transcript');
    const cardSynopsis = document.getElementById('card-synopsis');
    const cardTranscriptButton = document.getElementById('card-transcript-button');
    const cardTranscriptRead = document.getElementById('card-transcript-read');
    const cardTranscriptStatus = document.getElementById('card-transcript-status');
    const cardWeb = document.getElementById('card-web');
    const cardWebButton = document.getElementById('card-web-button');
    const cardWebRead = document.getElementById('card-web-read');
    const cardWebStatus = document.getElementById('card-web-status');
    const readerModal = document.getElementById('reader-modal');
    const readerTitle = document.getElementById('reader-title');
    const readerMeta = document.getElementById('reader-meta');
    const readerBody = document.getElementById('reader-body');
    const readerLink = document.getElementById('reader-link');
    const readerClose = document.getElementById('reader-close');
    const cardDelete = document.getElementById('card-delete');
    const cardAskInput = document.getElementById('card-ask-input');
    const cardAskButton = document.getElementById('card-ask-button');
    const cardAskAnswer = document.getElementById('card-ask-answer');
    const cardSpawnButton = document.getElementById('card-spawn-button');
    const cardResearch = document.getElementById('card-research');
    const cardResearchSummary = document.getElementById('card-research-summary');
    const cardResearchList = document.getElementById('card-research-list');
    const clusterDrawer = document.getElementById('cluster-drawer');
    const drawerDot = document.getElementById('drawer-dot');
    const drawerTitle = document.getElementById('drawer-title');
    const drawerCount = document.getElementById('drawer-count');
    const clusterCards = document.getElementById('cluster-cards');
    const drawerAskInput = document.getElementById('drawer-ask-input');
    const drawerAskButton = document.getElementById('drawer-ask-button');
    const drawerAskAnswer = document.getElementById('drawer-ask-answer');
    // Client-side mirror of the server's ASK_MAX_NODES.
    const ASK_MAX_NODES = 150;
    let drawerCluster = null;

    const setAskAnswer = (output, text, isError) => {
      output.textContent = text || '';
      output.classList.toggle('error', Boolean(isError));
      output.style.display = text ? 'block' : 'none';
    };
    // Each question is logged above its answer, so the box reads as a conversation. Returns the answer element.
    const addAskTurn = (output, question) => {
      if (output.classList.contains('error') || !output.querySelector('.ask-turn')) output.textContent = '';
      output.classList.remove('error');
      const turn = document.createElement('div');
      turn.className = 'ask-turn';
      const asked = document.createElement('div');
      asked.className = 'ask-q';
      asked.textContent = question;
      const answer = document.createElement('div');
      answer.className = 'ask-a pending';
      answer.textContent = 'Elarion is thinking…';
      turn.append(asked, answer);
      output.append(turn);
      output.style.display = 'block';
      output.scrollTop = output.scrollHeight;
      return answer;
    };

    const NEWLINE = String.fromCharCode(10);
    // Answer text followed by its web sources, as shown in the answer box, history and spawned nodes.
    const formatAnswer = (answer, sources) => {
      const sourceLines = (Array.isArray(sources) ? sources : []).map(source => '- ' + source.title + ' — ' + source.uri);
      return sourceLines.length ? [answer, '', 'Web sources:', ...sourceLines].join(NEWLINE) : answer;
    };

    // The latest card answer, kept so "+ Create Node from Answer" can prefill the Add Node form.
    let lastCardAnswer = null;

    const renderResearch = node => {
      const entries = Array.isArray(node.research) ? node.research : [];
      cardResearchSummary.textContent = 'Past Research & Q&A (' + entries.length + ')';
      cardResearchList.replaceChildren(...entries.slice().reverse().map(entry => {
        const item = document.createElement('details');
        item.className = 'research-entry';
        const summary = document.createElement('summary');
        summary.textContent = truncate(String(entry.question), 120);
        const asked = entry.asked_at ? new Date(entry.asked_at) : null;
        if (asked && !Number.isNaN(asked.getTime())) {
          const date = document.createElement('span');
          date.className = 'research-date';
          date.textContent = asked.toLocaleDateString();
          summary.appendChild(date);
        }
        const body = document.createElement('div');
        body.className = 'research-body';
        body.textContent = formatAnswer(String(entry.answer), entry.sources);
        const spawn = document.createElement('button');
        spawn.type = 'button';
        spawn.className = 'spawn-button';
        spawn.textContent = '+ Create Node from Answer';
        spawn.addEventListener('click', () => spawnFromAnswer(node, {
          question: String(entry.question),
          answer: String(entry.answer),
          sources: entry.sources
        }));
        item.append(summary, body, spawn);
        return item;
      }));
      cardResearch.style.display = entries.length ? 'block' : 'none';
    };

    // Longer texts (or many lines) also get the Expand Full Reader button.
    const READER_MIN_LENGTH = 280;
    const READER_MIN_LINES = 6;
    // Client-side mirror of the server's RESEARCH_MAX_ENTRIES.
    const RESEARCH_MAX_ENTRIES = 10;
    const truncate = (text, max) => text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;

    const getHostname = url => {
      try { return new URL(url).hostname.replace(/^www[.]/, ''); } catch (err) { return ''; }
    };

    const isHttpUrl = value => typeof value === 'string' && /^https?:/i.test(value);
    // Cover images: remote og:images, or a Telegram photo served by this worker.
    const isImageSrc = value => isHttpUrl(value) || (typeof value === 'string' && value.startsWith('/api/node-image/'));

    // One glyph per node type, shown on every badge next to the category name.
    const TYPE_ICONS = {
      note: '📝',
      general: '📄',
      link: '🔗',
      article: '📰',
      video: '▶️',
      dev_task: '🛠️',
      monetization: '💰',
      ai_tool: '🤖',
      marketing: '📣',
      route_plan: '🗺️',
      image: '🖼️'
    };
    const getTypeIcon = category => TYPE_ICONS[category] || '✦';

    // Saved favicon, else the site's /favicon.ico; notes have none.
    const getFaviconUrl = node => {
      if (isHttpUrl(node.favicon_url)) return node.favicon_url;
      if (!isHttpUrl(node.url)) return null;
      try { return new URL(node.url).origin + '/favicon.ico'; } catch (err) { return null; }
    };

    const buildFavicon = src => {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = src;
      img.addEventListener('error', () => img.remove());
      return img;
    };

    // Links show their fetched description; notes store their full text in url, so show that instead. Never clipped.
    const getFullText = (node, isLink) => {
      if (node.description) return String(node.description);
      if (!isLink && node.url && node.url !== node.title && !String(node.url).startsWith('aether:')) return String(node.url);
      return '';
    };

    // Link cards get a header with the Open Graph cover image, site name and a button to the saved URL;
    // photo cards show the image with a button to open it full size.
    const renderCardPreview = (node, isLink) => {
      const isPhoto = !isLink && isImageSrc(node.image_url);
      if (!isLink && !isPhoto) {
        cardPreview.style.display = 'none';
        cardPreviewImage.hidden = true;
        cardPreviewImage.removeAttribute('src');
        cardLink.removeAttribute('href');
        return;
      }
      cardLink.href = isLink ? node.url : node.image_url;
      styleLinkAction(cardLink, isLink ? node.url : node.image_url, isLink && isPlayableLink(node.url));
      cardSite.textContent = isPhoto ? '📸 Telegram photo' : (node.site_name || getHostname(node.source_url || node.url));
      const favicon = isLink ? getFaviconUrl(node) : null;
      if (favicon) {
        cardFavicon.src = favicon;
        cardFavicon.hidden = false;
      } else {
        cardFavicon.hidden = true;
        cardFavicon.removeAttribute('src');
      }
      if (isImageSrc(node.image_url)) {
        cardPreviewImage.src = node.image_url;
        cardPreviewImage.hidden = false;
      } else {
        cardPreviewImage.hidden = true;
        cardPreviewImage.removeAttribute('src');
      }
      cardPreview.style.display = 'block';
    };
    // Hotlink-blocked or dead cover images collapse instead of showing a broken icon.
    cardPreviewImage.addEventListener('error', () => { cardPreviewImage.hidden = true; });
    cardFavicon.addEventListener('error', () => { cardFavicon.hidden = true; });

    // ---- Outcome plan view (SPATIAL_ARCHITECTURE.md 8.5): steps with their cited saves, and the review actions ----
    const cardOutcome = document.getElementById('card-outcome');
    const cardOutcomeMeta = document.getElementById('card-outcome-meta');
    const cardOutcomeGoal = document.getElementById('card-outcome-goal');
    const cardOutcomeSteps = document.getElementById('card-outcome-steps');
    const cardOutcomeMessage = document.getElementById('card-outcome-message');
    const outcomeButtons = ['outcome-accept', 'outcome-regenerate', 'outcome-export', 'outcome-dismiss'].map(id => document.getElementById(id));
    const OUTCOME_TEMPLATE_LABELS = { project_setup: 'Project setup', sop_creation: 'SOP', content_creation: 'Content creation', ad_creation: 'Ad creation', website_creation: 'Website creation' };
    const OUTCOME_STATUS_LABELS = { proposed: 'Proposed by Elarion', accepted: 'Accepted', sent: 'Exported to Finish Line' };
    const renderCardOutcome = node => {
      const isOutcome = getNodeCategory(node) === 'outcome';
      cardOutcome.hidden = !isOutcome;
      nodeCard.classList.toggle('is-outcome', isOutcome);
      if (!isOutcome) return;
      const plan = node.outcome_plan || { steps: [] };
      cardOutcomeMeta.textContent = [OUTCOME_TEMPLATE_LABELS[plan.template], OUTCOME_STATUS_LABELS[node.outcome_status] || '', plan.effort].filter(Boolean).join(' · ');
      cardOutcomeGoal.textContent = plan.goal || '';
      cardOutcomeGoal.hidden = !plan.goal;
      // Mission Control fetches this outcome's blueprint and loads it into its Blueprints editor.
      document.getElementById('outcome-mission-control').href = '/mission-control?outcome=' + encodeURIComponent(node.id) + '#blueprints';
      cardOutcomeSteps.replaceChildren(...(plan.steps || []).map(step => {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = step.title;
        item.append(title);
        if (step.detail) item.append(document.createTextNode(step.detail));
        const sources = document.createElement('div');
        sources.className = 'card-outcome-sources';
        (step.inputs || []).forEach(id => {
          const input = graphData.nodes.find(item => item.id === id);
          if (!input) return;
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.textContent = input.title || 'Saved entry';
          chip.title = 'Show this save';
          chip.addEventListener('click', () => focusSavedNode(id));
          sources.append(chip);
        });
        if (sources.childNodes.length) item.append(sources);
        return item;
      }));
      const settled = node.outcome_status === 'accepted' || node.outcome_status === 'sent';
      outcomeButtons[0].hidden = settled;
      outcomeButtons[1].hidden = settled;
      outcomeButtons.forEach(button => { button.disabled = false; });
      cardOutcomeMessage.textContent = '';
    };
    // A cited save may be hidden by the current filters; clear them rather than do nothing.
    const focusSavedNode = id => {
      let node = Graph.graphData().nodes.find(item => item.id === id);
      if (!node && graphData.nodes.some(item => item.id === id)) {
        resetFilters();
        node = Graph.graphData().nodes.find(item => item.id === id);
      }
      if (node) focusCard(node);
    };
    const withOutcomeBusy = async (label, work) => {
      const node = focus.node;
      if (!node || getNodeCategory(node) !== 'outcome') return;
      outcomeButtons.forEach(button => { button.disabled = true; });
      cardOutcomeMessage.textContent = label;
      try {
        await work(node);
      } catch (err) {
        console.error('Outcome action failed:', err);
        cardOutcomeMessage.textContent = err.message || 'That did not work.';
      } finally {
        outcomeButtons.forEach(button => { button.disabled = false; });
      }
    };
    const setOutcomeStatus = async (node, status) => {
      await apiFetch('/api/node/' + encodeURIComponent(node.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome_status: status }) });
      node.outcome_status = status;
    };
    outcomeButtons[0].addEventListener('click', () => withOutcomeBusy('Accepting…', async node => {
      await setOutcomeStatus(node, 'accepted');
      renderCardOutcome(node);
      syncCards();
      cardOutcomeMessage.textContent = 'Accepted. Elarion will not rewrite this plan.';
    }));
    outcomeButtons[1].addEventListener('click', () => withOutcomeBusy('Elarion is rewriting the plan…', async node => {
      const fresh = await apiFetch('/api/outcome/' + encodeURIComponent(node.id) + '/regenerate', { method: 'POST' });
      node.title = node.name = fresh.title;
      node.description = fresh.description;
      node.outcome_plan = fresh.outcome_plan;
      showNodeCard(node);
      syncCards();
      cardOutcomeMessage.textContent = 'New plan written from the same saves.';
    }));
    outcomeButtons[2].addEventListener('click', () => withOutcomeBusy('Preparing the blueprint…', async node => {
      const blueprint = await apiFetch('/api/outcome/' + encodeURIComponent(node.id) + '/blueprint');
      const text = JSON.stringify(blueprint, null, 2);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      link.download = 'aether-blueprint-' + node.id + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      // The clipboard can wait on a permission prompt forever, so it never holds up the download.
      let copied = false;
      try {
        copied = await Promise.race([
          navigator.clipboard.writeText(text).then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 1500))
        ]);
      } catch (err) {}
      if (node.outcome_status !== 'sent') await setOutcomeStatus(node, 'sent');
      renderCardOutcome(node);
      syncCards();
      cardOutcomeMessage.textContent = (copied ? 'Blueprint copied and downloaded' : 'Blueprint downloaded') + ' (aether.blueprint/1) for Finish Line.';
    }));
    outcomeButtons[3].addEventListener('click', () => withOutcomeBusy('Dismissing…', async node => {
      await setOutcomeStatus(node, 'dismissed');
      graphData.nodes = graphData.nodes.filter(item => item.id !== node.id);
      graphData.links = graphData.links.filter(link => linkEndId(link.source) !== node.id && linkEndId(link.target) !== node.id);
      closeClusterDrawer();
      hideNodeCard();
      applyGraphFilters();
    }));

    const showNodeCard = node => {
      if (focus.node !== node) nodeCard.classList.remove('expanded');
      const isLink = Boolean(node.url && /^https?:/i.test(node.url));
      cardTitle.textContent = node.title || node.name || 'Saved Entry';
      cardTag.textContent = getTypeIcon(getNodeCategory(node)) + ' ' + getNodeCategory(node).replace(/_/g, ' ').toUpperCase();
      renderCardGroup(node);

      renderCardPreview(node, isLink);

      const note = node.user_note ? String(node.user_note) : '';
      cardNoteText.textContent = note;
      cardNote.style.display = note ? 'block' : 'none';
      cardNoteText.scrollTop = 0;

      const fullText = getFullText(node, isLink);
      cardDescription.textContent = fullText;
      cardDescription.style.display = fullText ? 'block' : 'none';
      cardDescription.scrollTop = 0;
      const readable = note + NEWLINE + fullText;
      const isLong = readable.length > READER_MIN_LENGTH || readable.split(NEWLINE).length > READER_MIN_LINES;
      cardReaderButton.style.display = isLong || readerMediaFor(node, readable) ? 'inline-block' : 'none';
      renderCardLinks(node);

      const created = node.created_at ? new Date(node.created_at) : null;
      cardMeta.textContent = created && !Number.isNaN(created.getTime()) ? created.toLocaleString() : '';
      cardAskInput.value = '';
      setAskAnswer(cardAskAnswer, '');
      lastCardAnswer = null;
      cardSpawnButton.style.display = 'none';
      renderResearch(node);
      renderCardStatus(node);
      renderCardTranscript(node);
      renderCardWeb(node);
      renderCardOutcome(node);
      nodeCard.style.display = 'block';
      document.body.classList.add('card-open');
      // On phones the card is a bottom sheet over the legend, so the legend steps aside while it's open.
      if (compactLayout.matches) legend.style.display = 'none';
    };

    // Fresh accessors make the graph re-evaluate colors, widths and particles.
    const refreshLinkStyles = () => {
      Graph
        .linkColor(link => getLinkColor(link))
        // Hairline links (width 0 draws a 1px line) so they never turn into bars in front of a close-up card.
        .linkWidth(0)
        .linkDirectionalParticles(link => isActiveLink(link) ? 4 : 0)
        .linkDirectionalParticleWidth(link => isActiveLink(link) ? 0.6 : 0);
    };

    const refreshGraphStyles = () => {
      Graph.nodeColor(node => getNodeColor(node));
      refreshLinkStyles();
      // Cards ignore nodeColor/nodeOpacity; their targets and faces update in place.
      syncCards();
      if (territories.group) territories.group.visible = !focus.node && !gallery && !filterState.flat;
      syncTerritoryEmphasis();
    };

    // Each visible cluster gets a floating label (AI-suggested groups are marked with a spark). The wireframe shells are
    // gone (D5); group proxies replace them in Phase 4b.
    const territories = { group: null, entries: new Map(), visibleNodes: [] };

    const LABEL_WIDTH = 48;
    const LABEL_HEIGHT = 12;
    // In a headset, group labels are this tall (metres) whatever the world scale, instead of 12 graph units, which
    // made them tower over the shrunken cards.
    const XR_LABEL_HEIGHT_M = 0.025;
    const makeLabelSprite = (text, color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.font = '600 64px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(text, 256, 64);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.75, depthWrite: false }));
      sprite.scale.set(LABEL_WIDTH, LABEL_HEIGHT, 1);
      return sprite;
    };

    const disposeTerritory = entry => {
      territories.group.remove(entry.label);
      entry.label.material.map.dispose();
      entry.label.material.dispose();
    };

    const syncTerritories = visibleNodes => {
      territories.visibleNodes = visibleNodes;
      if (!territories.group) return;
      const keys = new Set(visibleNodes.map(getClusterKey));
      territories.entries.forEach((entry, key) => {
        if (keys.has(key)) return;
        disposeTerritory(entry);
        territories.entries.delete(key);
      });
      keys.forEach(key => {
        const color = getClusterColor(key);
        const text = (isAiCluster(key) ? '✦ ' : '') + getClusterLabel(key).toUpperCase();
        const existing = territories.entries.get(key);
        // A renamed or recoloured cluster gets a fresh label.
        if (existing && existing.text === text && existing.color === color) return;
        if (existing) disposeTerritory(existing);
        const label = makeLabelSprite(text, color);
        label.userData.cluster = key;
        territories.group.add(label);
        territories.entries.set(key, { label, text, color });
      });
      updateTerritories();
      syncTerritoryEmphasis();
    };

    // While the legend highlight or platform bar is dimming, a category's shell and label fade unless it
    // still holds an emphasized node, so the lit nodes stand out instead of every cluster glowing.
    const LABEL_OPACITY = 0.75;
    const syncTerritoryEmphasis = () => {
      if (!territories.group) return;
      const dimming = isDimming();
      const lit = new Set(dimming ? territories.visibleNodes.filter(isHighlighted).map(getClusterKey) : []);
      territories.entries.forEach((entry, key) => {
        const on = !dimming || lit.has(key);
        entry.label.material.opacity = on ? LABEL_OPACITY : 0.15;
      });
    };

    const updateTerritories = () => {
      if (!territories.group) return;
      const groups = new Map();
      territories.visibleNodes.forEach(node => {
        if (!Number.isFinite(node.x)) return;
        const key = getClusterKey(node);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
      });
      territories.entries.forEach((entry, key) => {
        const nodes = groups.get(key) || [];
        entry.label.visible = nodes.length > 0;
        entry.hasNodes = nodes.length > 0;
        if (!nodes.length) return;
        const center = { x: 0, y: 0, z: 0 };
        nodes.forEach(node => { center.x += node.x; center.y += node.y; center.z += node.z || 0; });
        center.x /= nodes.length;
        center.y /= nodes.length;
        center.z /= nodes.length;
        const spread = Math.max(...nodes.map(node => Math.hypot(node.x - center.x, node.y - center.y, (node.z || 0) - center.z)));
        const radius = Math.max(spread + 12, 18);
        entry.label.position.set(center.x, center.y + radius + 8, center.z);
        entry.center = center;
        entry.radius = radius;
      });
      // Group proxies (SPATIAL_ARCHITECTURE.md 2.5): each cluster's centre, size, members and newest card.
      if (cardField) {
        const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
        cardField.setClusters([...groups].filter(([key]) => territories.entries.get(key) && territories.entries.get(key).center).map(([key, nodes]) => ({
          key,
          center: territories.entries.get(key).center,
          radius: territories.entries.get(key).radius,
          ids: nodes.map(node => node.id),
          label: (isAiCluster(key) ? '✦ ' : '') + getClusterLabel(key),
          color: getClusterColor(key),
          count: nodes.length,
          topId: [...nodes].sort(newestFirst)[0].id
        })));
      }
    };

    // Labels live outside the library's picking, so a click on one arrives as a background click.
    let lastPointer = null;
    const pickLabel = () => {
      if (!THREE || !territories.group || !lastPointer) return null;
      const rect = Graph.renderer().domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((lastPointer.x - rect.left) / rect.width) * 2 - 1,
        -((lastPointer.y - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.camera = Graph.camera();
      raycaster.setFromCamera(pointer, Graph.camera());
      const labels = [...territories.entries.values()].map(entry => entry.label).filter(label => label.visible);
      const proxies = cardField ? cardField.proxyTargets() : [];
      const hit = raycaster.intersectObjects([...labels, ...proxies], false)[0];
      return hit ? hit.object.userData.cluster : null;
    };

    // Frames a bounding sphere from the current viewing direction (straight on in 2D).
    // Group state (SPATIAL_ARCHITECTURE.md 2.1): frames a cluster's bounding sphere from the current direction
    // (straight on in 2D), never closer than the node framing.
    const flyToBounds = (center, radius, cluster = null) => {
      const distance = Math.max(GROUP_MIN_DISTANCE, fitSphere(radius, CLUSTER_FIT_MARGIN));
      clusterFrame = cluster ? { key: cluster, distance } : null;
      cameraGoTo({
        target: { x: center.x, y: center.y, z: center.z },
        distance,
        ...(filterState.flat ? FLAT_ORBIT : {}),
        state: 'group',
        detail: cluster
      });
    };

    const flyToCluster = key => {
      if (gallery && gallery.key === key) {
        flyToArc();
        return;
      }
      const entry = territories.entries.get(key);
      if (entry && entry.center) flyToBounds(entry.center, entry.radius, key);
    };

    const flyToCategory = category => {
      const nodes = Graph.graphData().nodes.filter(node => getNodeCategory(node) === category && [node.x, node.y, node.z].every(Number.isFinite));
      if (!nodes.length) return;
      const center = { x: 0, y: 0, z: 0 };
      nodes.forEach(node => { center.x += node.x; center.y += node.y; center.z += node.z; });
      center.x /= nodes.length;
      center.y /= nodes.length;
      center.z /= nodes.length;
      const spread = Math.max(...nodes.map(node => Math.hypot(node.x - center.x, node.y - center.y, node.z - center.z)));
      flyToBounds(center, Math.max(spread + 12, 18), 'category:' + category);
    };

    const formatCategory = category => category.replace(/_/g, ' ');

    const buildMiniCard = node => {
      const isLink = Boolean(node.url && /^https?:/i.test(node.url));
      const card = document.createElement('button');
      card.className = 'mini-card';
      card.dataset.id = node.id;
      card.classList.toggle('active', Boolean(focus.node && focus.node.id === node.id));
      const title = document.createElement('strong');
      title.textContent = node.title || node.name || 'Saved Entry';
      const detail = document.createElement('span');
      detail.textContent = [isLink ? getHostname(node.url) : '', truncate(getFullText(node, isLink), 110)].filter(Boolean).join(' · ');
      card.append(title, detail);
      if (isLink) card.append(buildLinkAction(node));
      // The drawer stays open: the card lights up, the canvas focuses and flies to the node.
      card.addEventListener('click', () => selectNode(node, { fly: true }));
      // Touch screens emulate mouseenter on tap and never leave, so hover sync is mouse-only.
      card.classList.toggle('hover', hover.id === node.id);
      card.addEventListener('mouseenter', () => { if (hoverCapable.matches) setHover(node, 'drawer'); });
      card.addEventListener('mouseleave', () => { if (hover.id === node.id) setHover(null); });
      return card;
    };

    const syncDrawerHover = scroll => {
      let hoverCard = null;
      clusterCards.querySelectorAll('.mini-card').forEach(card => {
        const isHover = card.dataset.id === hover.id;
        card.classList.toggle('hover', isHover);
        if (isHover) hoverCard = card;
      });
      if (scroll && hoverCard) hoverCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    };

    const setHover = (node, source) => {
      const id = node ? node.id : null;
      if (id === hover.id) return;
      if (hover.id) applyNodeHover(Graph.graphData().nodes.find(item => item.id === hover.id), false);
      hover.id = id;
      hover.source = node ? source : null;
      if (node) applyNodeHover(node, true);
      if (!focus.node) Graph.linkOpacity(hover.id ? 1 : BASE_LINK_OPACITY);
      refreshLinkStyles();
      // Only canvas hovers scroll the list; scrolling under a hovered card would make it jump.
      syncDrawerHover(source === 'canvas');
    };

    // Mirror the focused node onto the drawer list (either direction: card tap or canvas click).
    const syncDrawerSelection = () => {
      const activeId = focus.node ? focus.node.id : null;
      let activeCard = null;
      clusterCards.querySelectorAll('.mini-card').forEach(card => {
        const isActive = card.dataset.id === activeId;
        card.classList.toggle('active', isActive);
        if (isActive) activeCard = card;
      });
      if (activeCard) activeCard.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      let activeItem = null;
      collectionItems.querySelectorAll('.item-card').forEach(card => {
        const isActive = card.dataset.id === activeId;
        card.classList.toggle('active', isActive);
        if (isActive) activeItem = card;
      });
      // The carousel places its own cards; scrolling to one would jump the deck.
      if (activeItem && filterState.view !== 'graph' && filterState.view !== 'carousel') activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    // Node state: close framing on one card, shifted so it sits in the part of the view the node card does not cover.
    // In the gallery (stop 4, Atomic) the camera moves along the card's radius toward the wall until the card, grown
    // 1.15 and slid a little toward the viewer, fills ATOMIC_FILL of the part of the screen the panels and the top bar
    // leave free (getWallView; on desktop the details panel narrows it). It is never pushed nearer than that fit, which
    // put the top of the card under the top bar.
    const flyToNode = node => {
      if (![node.x, node.y, node.z].every(Number.isFinite)) return;
      const cover = getCardCover();
      if (gallery && gallery.ids.has(node.id)) {
        const slot = cardField.galleryPosition(node.id);
        if (slot) {
          gallery.look = { yaw: window.AetherSpatial.yawToward(gallery.origin, slot), y: slot.y };
          // The headset places the viewer itself (xrOnSelect).
          if (xrPresenting()) return;
          // The group list steps aside first, so the framing below uses the room it leaves.
          setAtomicLayout(true);
          const cover = getCardCover();
          const spatial = window.AetherSpatial;
          const vFov = cameraFov();
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Graph.camera().aspect);
          const free = getWallView(cover);
          const fits = Math.max(
            (spatial.CARD_WIDTH * 1.15) / (ATOMIC_FILL.width * free.width * 2 * Math.tan(hFov / 2)),
            (spatial.CARD_HEIGHT * 1.15) / (ATOMIC_FILL.height * free.height * 2 * Math.tan(vFov / 2)),
            cappedCardDistance(spatial.CARD_WIDTH * 1.15, ATOMIC_MAX_CARD_PX)
          );
          const slide = Math.min(ATOMIC_SLIDE * fits, 0.5 * gallery.radius);
          cardField.setGallerySlide(slide);
          cameraGoTo({ ...arcPose(gallery.look, fits + slide), state: 'node', detail: node.id });
          return;
        }
      }
      const orbit = filterState.flat ? FLAT_ORBIT : getOrbit();
      const distance = getNodeDistance(cover);
      const point = (filterState.flat && cardField && cardField.boardSlot(node.id)) || { x: node.x, y: node.y, z: node.z };
      const target = window.AetherSpatial
        ? window.AetherSpatial.uncoveredTarget(point, { ...orbit, distance, vFov: cameraFov(), aspect: Graph.camera().aspect }, cover)
        : point;
      cameraGoTo({ target, distance, ...(filterState.flat ? FLAT_ORBIT : {}), state: 'node', detail: node.id });
    };

    // Visible nodes only, so the drawer agrees with the current filters.
    // 'outcome:<id>' is an Outcome Node's own gallery: the outcome first, then the saves it cites.
    const getClusterNodes = key => key.startsWith('outcome:')
      ? getOutcomeMembers(key.slice('outcome:'.length))
      : Graph.graphData().nodes
      .filter(node => getClusterKey(node) === key)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    const renderClusterDrawer = () => {
      if (!drawerCluster) return;
      const nodes = getClusterNodes(drawerCluster);
      drawerCount.textContent = nodes.length + (nodes.length === 1 ? ' card' : ' cards');
      clusterCards.replaceChildren(...nodes.map(buildMiniCard));
    };

    const openClusterDrawer = (key, options = {}) => {
      const changed = drawerCluster !== key;
      drawerCluster = key;
      drawerDot.style.background = getClusterColor(key);
      clusterDrawer.classList.toggle('is-outcome', key.indexOf('outcome:') === 0);
      drawerTitle.textContent = (isAiCluster(key) ? '✦ ' : '') + getClusterLabel(key);
      drawerAskInput.placeholder = 'Ask Elarion about ' + getClusterLabel(key);
      if (changed) {
        drawerAskInput.value = '';
        setAskAnswer(drawerAskAnswer, '');
      }
      renderClusterDrawer();
      clusterCards.scrollTop = clusterCards.scrollLeft = 0;
      // Phones open it as the small tab (its title opens the full sheet).
      if (changed) clusterDrawer.classList.remove('expanded');
      clusterDrawer.classList.add('open');
      document.body.classList.add('drawer-open');
      legend.style.display = 'none';
      if (!gallery || gallery.key !== key) {
        // The new wall flies the camera itself, so leaving the old one does not fly to its cluster first.
        if (gallery) exitGallery({ fly: false });
        enterGallery(key, options.centerId || null);
      } else if (options.centerId) {
        refreshGallery(options.centerId);
      }
    };

    // options.fly false: leaving the wall does not fly to its cluster (the caller moves the camera).
    const closeClusterDrawer = (options = {}) => {
      if (!clusterDrawer.classList.contains('open')) return;
      clusterDrawer.classList.remove('open');
      document.body.classList.remove('drawer-open');
      // A hidden card never fires mouseleave, so its hover is dropped here.
      if (hover.source === 'drawer') setHover(null);
      drawerCluster = null;
      if (nodeCard.style.display !== 'block') legend.style.display = 'block';
      exitGallery({ fly: options.fly !== false });
    };

    // Empty canvas resets everything: drawer, card, highlight, and the idle orbit restarts right away.
    // options.fly false: a wall that closes does not fly to its cluster (the caller moves the camera).
    const resetSelection = (options = {}) => {
      closeClusterDrawer(options);
      hideNodeCard();
      if (filterState.highlighted.size) {
        filterState.highlighted = new Set();
        applyGraphFilters();
      }
      clearTimeout(idleTimer);
      resumeAutoRotate();
    };

    // Front-on view of every visible node, camera on the +z side of their centre: the flat 2D canvas fits its
    // x/y extent, 3D fits a bounding sphere so the whole graph stays in view.
    // Where the Macro framing of everything visible puts the camera: { center, distance }.
    const getMacroFraming = () => {
      const camera = Graph.camera();
      const vFov = camera.fov * Math.PI / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      if (filterState.flat && boardState) return getBoardFraming(vFov, hFov);
      const bbox = Graph.getGraphBbox();
      let center = { x: 0, y: 0, z: 0 };
      let distance = 600;
      if (bbox) {
        const halfW = (bbox.x[1] - bbox.x[0]) / 2;
        const halfH = (bbox.y[1] - bbox.y[0]) / 2;
        const halfD = (bbox.z[1] - bbox.z[0]) / 2;
        center = { x: (bbox.x[0] + bbox.x[1]) / 2, y: (bbox.y[0] + bbox.y[1]) / 2, z: filterState.flat ? 0 : (bbox.z[0] + bbox.z[1]) / 2 };
        const fit = filterState.flat
          ? Math.max(halfH / Math.tan(vFov / 2), halfW / Math.tan(hFov / 2))
          : Math.hypot(halfW, halfH, halfD) / Math.sin(Math.min(vFov, hFov) / 2);
        distance = Math.max(fit * 1.1 + 20, 120);
      }
      return { center, distance };
    };
    const resetCameraView = () => {
      const { center, distance } = getMacroFraming();
      // Macro state, or Group when every visible node is in one cluster (a filter such as Day narrowed it).
      const clusters = new Set(Graph.graphData().nodes.map(getClusterKey));
      const single = clusters.size === 1 ? [...clusters][0] : null;
      cameraGoTo({
        target: center,
        distance,
        ...(filterState.flat ? FLAT_ORBIT : {}),
        state: single ? 'group' : 'macro',
        detail: single
      });
    };

    // Layout health. Categories settle around anchors spread away from the origin; a layout that never ran leaves
    // every node in d3's starting spiral at the origin, so the category centres bunch up there. Collapsed means
    // their average distance from the origin is under COLLAPSE_SHARE of their anchors' average (or a node has no
    // position), and the nodes are then re-seeded at the anchors.
    const COLLAPSE_SHARE = 0.35;
    const SEED_SPREAD = 14;
    let layoutDirty = false;

    const countByCluster = nodes => {
      const counts = new Map();
      nodes.forEach(node => counts.set(getClusterKey(node), (counts.get(getClusterKey(node)) || 0) + 1));
      return counts;
    };

    const isLayoutCollapsed = nodes => {
      if (!nodes.length) return false;
      const sums = new Map();
      for (const node of nodes) {
        if (![node.x, node.y, node.z].every(Number.isFinite)) return true;
        const key = getClusterKey(node);
        const sum = sums.get(key) || { x: 0, y: 0, z: 0, n: 0 };
        sum.x += node.x;
        sum.y += node.y;
        sum.z += node.z;
        sum.n += 1;
        sums.set(key, sum);
      }
      let centreDistance = 0;
      let anchorDistance = 0;
      sums.forEach((sum, key) => {
        const anchor = getClusterAnchor(key);
        centreDistance += Math.hypot(sum.x / sum.n, sum.y / sum.n, sum.z / sum.n);
        anchorDistance += Math.hypot(anchor.x, anchor.y, anchor.z);
      });
      return centreDistance < anchorDistance * COLLAPSE_SHARE;
    };

    // Each node starts in a small cloud around its cluster anchor, so the graph is spread out from the first frame.
    const seedLayout = nodes => {
      const counts = countByCluster(nodes);
      nodes.forEach(node => {
        const key = getClusterKey(node);
        const anchor = getClusterAnchor(key);
        const spread = SEED_SPREAD * Math.sqrt(counts.get(key));
        const jitter = () => (Math.random() - 0.5) * 2 * spread;
        node.x = anchor.x + jitter();
        node.y = anchor.y + jitter();
        node.z = filterState.flat ? 0 : anchor.z + jitter();
        node.vx = 0;
        node.vy = 0;
        node.vz = 0;
      });
    };

    // Camera fits after a mode change: once right away, and again when the layout has mostly settled, unless the
    // user has started moving the camera in between.
    const FIT_SETTLE_MS = 1600;
    let fitTimer = null;
    const cancelPendingFit = () => {
      clearTimeout(fitTimer);
      fitTimer = null;
    };
    const scheduleFit = (delay = FIT_SETTLE_MS) => {
      cancelPendingFit();
      fitTimer = setTimeout(() => {
        fitTimer = null;
        if (filterState.view === 'graph' && !focus.node) resetCameraView();
      }, delay);
    };
    const graphElement = document.getElementById('3d-graph');
    graphElement.addEventListener('pointerdown', cancelPendingFit, { passive: true });
    graphElement.addEventListener('wheel', cancelPendingFit, { passive: true });

    // Called whenever the graph comes back on screen: restarts a layout that stalled while hidden and frames it.
    const wakeLayout = () => {
      const nodes = Graph.graphData().nodes;
      const collapsed = isLayoutCollapsed(nodes);
      if (collapsed) seedLayout(nodes);
      if (collapsed || layoutDirty) Graph.d3ReheatSimulation();
      layoutDirty = false;
      if (focus.node) return;
      resetCameraView();
      scheduleFit();
    };

    // Double-click / double-tap on empty canvas resets the view: two background clicks close together in time
    // and space. Node clicks go to onNodeClick and edge clicks never reach here; a label click opens its cluster.
    const DOUBLE_TAP_MS = 350;
    const DOUBLE_TAP_PX = 30;
    let lastBackgroundTap = null;

    // The graph library only reports a click for whatever its throttled hover raycast last saw, and while the camera
    // flies out of a gallery (after the first tap) that can be a card sliding past, or nothing at all. So the second
    // tap is recognised here from the raw pointer release, and the library's own click for it is ignored.
    let lastTapUp = { time: 0, point: null };
    let ignoreClickUntil = 0;
    const isSecondTap = point => {
      const previous = lastBackgroundTap;
      return Boolean(previous && point && previous.point && Date.now() - previous.time <= DOUBLE_TAP_MS
        && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= DOUBLE_TAP_PX);
    };
    const ignoringClick = () => {
      if (Date.now() >= ignoreClickUntil) return false;
      ignoreClickUntil = 0;
      return true;
    };
    // The first tap already closed the panels and left any gallery (resetSelection); the second zooms out to the
    // whole graph.
    const finishDoubleTap = () => {
      const previous = lastBackgroundTap;
      lastBackgroundTap = null;
      // A card may have opened under the second tap; close everything again.
      if (gallery || focus.node) resetSelection();
      // The first click cleared the legend highlight; a double-click only moves the camera, so restore it.
      if (previous.highlighted.size && !filterState.highlighted.size) {
        filterState.highlighted = previous.highlighted;
        applyGraphFilters();
      }
      resetCameraView();
    };

    const handleBackgroundClick = () => {
      if (ignoringClick()) return;
      // Group labels and proxies are hidden in the gallery, so there a tap on the background is only a tap.
      const cluster = gallery ? null : pickLabel();
      if (cluster) {
        lastBackgroundTap = null;
        flyToCluster(cluster);
        openClusterDrawer(cluster);
        return;
      }
      // Timed from the release, not from this (animation-frame delayed) callback.
      const point = lastTapUp.point || (lastPointer ? { x: lastPointer.x, y: lastPointer.y } : null);
      lastBackgroundTap = { time: lastTapUp.time || Date.now(), point, highlighted: new Set(filterState.highlighted) };
      // Something was selected (a card, a group or its wall, a framed cluster, a highlight): deselecting also lets go of
      // the group as the orbit's pivot, so turning the view afterwards turns the whole scene, not the old group.
      const selected = Boolean(gallery || focus.node || drawerCluster || clusterFrame || filterState.highlighted.size) || zoomStop === 'cluster';
      resetSelection({ fly: false });
      if (selected) recentreOrbit();
    };
    // Moves the orbit's pivot back to the scene centre (the origin, where the cluster anchors are spread around) and
    // unselects the framed group, keeping the camera where it is (stepped back if it is inside the cloud's middle), so
    // the view turns smoothly to the centre.
    const recentreOrbit = () => {
      if (filterState.view !== 'graph' || filterState.flat || xrPresenting()) return;
      clusterFrame = null;
      const camera = Graph.camera().position;
      const length = camera.length() || 1;
      cameraGoTo({
        target: { x: 0, y: 0, z: 0 },
        distance: Math.max(length, getMacroFraming().distance * 0.5),
        theta: Math.atan2(camera.x, camera.z),
        phi: Math.acos(Math.min(1, Math.max(-1, camera.y / length))),
        state: 'macro'
      });
    };

    // Slow idle orbit that yields to any interaction and resumes after a quiet spell.
    const IDLE_RESUME_MS = 5000;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let idleTimer = null;
    const resumeAutoRotate = () => {
      const controls = Graph.controls();
      controls.autoRotate = !focus.node && !filterState.flat && !gallery && !reducedMotion.matches;
    };
    const scheduleResume = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(resumeAutoRotate, IDLE_RESUME_MS);
    };
    const pauseAutoRotate = () => {
      Graph.controls().autoRotate = false;
      scheduleResume();
    };

    let territoryTicks = 0;
    const onTerritoryTick = () => {
      territoryTicks = (territoryTicks + 1) % 10;
      if (territoryTicks === 0) updateTerritories();
    };

    const setFocus = node => {
      focus.node = node;
      focus.nodeIds = new Set([node.id]);
      Graph.graphData().links.forEach(link => {
        const sourceId = linkEndId(link.source);
        const targetId = linkEndId(link.target);
        if (sourceId !== node.id && targetId !== node.id) return;
        focus.nodeIds.add(sourceId);
        focus.nodeIds.add(targetId);
      });
      // Full opacity for the focused set means lifting the global multipliers too.
      Graph.nodeOpacity(1).linkOpacity(1);
      refreshGraphStyles();
    };

    const clearFocus = () => {
      if (!focus.node) return;
      focus.node = null;
      focus.nodeIds = new Set();
      Graph.nodeOpacity(BASE_NODE_OPACITY).linkOpacity(hover.id ? 1 : BASE_LINK_OPACITY);
      refreshGraphStyles();
    };

    // Card carousel: the opened node's connected cluster (visible AI/manual edges), or its category when it has none.
    const carousel = { ids: [], label: '' };
    const cardCarousel = document.getElementById('card-carousel');
    const cardCounter = document.getElementById('card-counter');

    const titleCase = text => text.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    // Members reachable over drawn edges, walked breadth-first from the best-connected member (neighbours by
    // degree, then title) so the order is the same whichever card you enter from.
    const getConnectedCluster = node => {
      const adjacency = new Map();
      const connect = (a, b) => {
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        adjacency.get(a).add(b);
      };
      Graph.graphData().links.forEach(link => {
        if (link.type !== 'ai') return;
        const a = linkEndId(link.source);
        const b = linkEndId(link.target);
        if (a === b) return;
        connect(a, b);
        connect(b, a);
      });
      if (!adjacency.has(node.id)) return [];

      const members = new Set([node.id]);
      const pending = [node.id];
      while (pending.length) {
        adjacency.get(pending.shift()).forEach(id => {
          if (!members.has(id)) {
            members.add(id);
            pending.push(id);
          }
        });
      }
      const byId = new Map(Graph.graphData().nodes.map(item => [item.id, item]));
      const rank = (a, b) => (adjacency.get(b).size - adjacency.get(a).size) || String(byId.get(a)?.title || '').localeCompare(String(byId.get(b)?.title || ''));
      const start = [...members].sort(rank)[0];
      const order = [];
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const id = queue.shift();
        order.push(id);
        [...adjacency.get(id)].sort(rank).forEach(next => {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        });
      }
      return order.filter(id => byId.has(id));
    };

    const buildCarousel = node => {
      const connected = getConnectedCluster(node);
      if (connected.length > 1) {
        carousel.ids = connected;
        carousel.label = 'Connected Cluster';
        return;
      }
      const key = getClusterKey(node);
      const members = getClusterNodes(key).map(item => item.id);
      carousel.ids = members.length > 1 ? members : [];
      carousel.label = titleCase(getClusterLabel(key)) + ' Cluster';
    };

    const renderCarousel = node => {
      const index = carousel.ids.indexOf(node.id);
      const active = carousel.ids.length > 1 && index !== -1;
      cardCarousel.hidden = !active;
      if (active) cardCounter.textContent = 'Card ' + (index + 1) + ' of ' + carousel.ids.length + ' in ' + carousel.label;
    };

    // Wraps around; members hidden by filters since the list was built are skipped.
    const stepCarousel = delta => {
      const node = focus.node;
      if (!node || nodeCard.style.display !== 'block') return;
      const count = carousel.ids.length;
      const index = carousel.ids.indexOf(node.id);
      if (count < 2 || index === -1) return;
      const visible = new Map(Graph.graphData().nodes.map(item => [item.id, item]));
      for (let step = 1; step < count; step++) {
        const next = visible.get(carousel.ids[((index + delta * step) % count + count) % count]);
        if (next) {
          focusCard(next, { keepCarousel: true });
          return;
        }
      }
    };

    const selectNode = (node, options = {}) => {
      // Keep the drawer only when the node belongs to the cluster it lists.
      if (drawerCluster !== getClusterKey(node) && !(gallery && gallery.ids.has(String(node.id)))) closeClusterDrawer();
      showNodeCard(node);
      if (!options.keepCarousel || !carousel.ids.includes(node.id)) buildCarousel(node);
      renderCarousel(node);
      setFocus(node);
      syncDrawerSelection();
      syncDeck(node);
      // The ◀ ▶ arrows under the card (placeGalleryNav decides whether it has anywhere to step to).
      startGalleryNav();
      // The camera only matters while the graph is on screen.
      if (filterState.view !== 'graph') return;
      pauseAutoRotate();
      if (options.fly) flyToNode(node);
    };

    const hideNodeCard = () => {
      if (window.AetherSpatial) window.AetherSpatial.closeGroupPicker();
      nodeCard.style.display = 'none';
      nodeCard.style.transform = '';
      document.body.classList.remove('card-open');
      setAtomicLayout(false);
      if (!clusterDrawer.classList.contains('open')) legend.style.display = 'block';
      clearFocus();
      syncDrawerSelection();
      scheduleResume();
    };

    // ---- Group picker (SPATIAL_ARCHITECTURE.md 1.6): move a node to a group or create one, from any card ----
    const toPickerGroup = (group, count) => ({
      id: group.id,
      name: group.name,
      source: group.source,
      count,
      color: window.AetherSpatial.groupColor('group:' + group.id)
    });
    const getPickerGroups = () => {
      const counts = new Map();
      graphData.nodes.forEach(node => { if (node.group_id) counts.set(node.group_id, (counts.get(node.group_id) || 0) + 1); });
      return (graphData.groups || []).map(group => toPickerGroup(group, counts.get(group.id) || 0));
    };
    const getNodeGroup = node => {
      const group = node.group_id ? (graphData.groups || []).find(item => item.id === node.group_id) : null;
      return group ? toPickerGroup(group, 0) : null;
    };
    const makeGroupPicker = node => window.AetherSpatial ? window.AetherSpatial.createGroupPicker({
      getGroups: getPickerGroups,
      getCurrent: () => getNodeGroup(node),
      onChoose: choice => assignGroup(node, choice)
    }) : null;
    const renderCardGroup = node => {
      const picker = makeGroupPicker(node);
      cardGroup.replaceChildren(...(picker ? [picker.element] : []));
    };

    // A group change re-clusters in place: new cluster keys, anchors, labels and lists, then a reheat so the moved
    // node glides to its new island (the rest of the layout is already settled and barely moves).
    const reclusterLive = () => {
      updateClusters(currentVisibleNodes);
      updateClusterSpacing(currentVisibleNodes);
      syncTerritories(currentVisibleNodes);
      layoutBoard();
      renderClusterDrawer();
      syncCards();
      refreshGallery();
      if (focus.node && nodeCard.style.display === 'block') {
        renderCardGroup(focus.node);
        buildCarousel(focus.node);
        renderCarousel(focus.node);
      }
      if (filterState.view === 'graph') Graph.d3ReheatSimulation();
      else {
        layoutDirty = true;
        renderCollection();
      }
    };

    // Optimistic: the node moves at once and the choice is saved after; a failed save moves it back. A new group gets
    // a temporary id until the server returns the real one.
    const assignGroup = async (node, choice) => {
      const before = { group_id: node.group_id, group_source: node.group_source };
      let body;
      let tempId = null;
      if (choice.newName) {
        const existing = (graphData.groups || []).find(group => group.name.toLowerCase() === choice.newName.toLowerCase());
        if (existing) {
          node.group_id = existing.id;
          body = { group_id: existing.id };
        } else {
          tempId = 'pending_' + Date.now();
          graphData.groups = [...(graphData.groups || []), { id: tempId, name: choice.newName, source: 'user', count: 0 }];
          node.group_id = tempId;
          body = { new_group: choice.newName };
        }
      } else if (choice.remove) {
        node.group_id = null;
        body = { group_id: null };
      } else {
        node.group_id = choice.groupId;
        body = { group_id: choice.groupId };
      }
      node.group_source = 'user';
      reclusterLive();

      try {
        const res = await fetch('/api/node/' + encodeURIComponent(node.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('Saving the group failed: ' + res.status));
        if (tempId && data.group) {
          graphData.groups = graphData.groups.filter(group => group.id !== tempId);
          if (!graphData.groups.some(group => group.id === data.group.id)) graphData.groups.push(data.group);
          renameClusterSlot('group:' + tempId, 'group:' + data.group.id);
          graphData.nodes.forEach(item => { if (item.group_id === tempId) item.group_id = data.group.id; });
          reclusterLive();
        }
      } catch (err) {
        console.error('Group change failed:', err);
        node.group_id = before.group_id;
        node.group_source = before.group_source;
        if (tempId) graphData.groups = graphData.groups.filter(group => group.id !== tempId);
        reclusterLive();
        alert(err.message || 'Saving the group failed.');
      }
    };

    // The spatial modules (public/js/spatial/) load as a module script, after this one; their design tokens
    // replace the defaults here once they are ready.
    let particleColor = '#00ffcc';
    const applySpatialTokens = () => { particleColor = window.AetherSpatial.tokens.accent; };
    if (window.AetherSpatial) applySpatialTokens();
    else window.addEventListener('aether-spatial-ready', applySpatialTokens, { once: true });

    const Graph = ForceGraph3D({ controlType: 'orbit' })(document.getElementById('3d-graph'))
      .nodeLabel(node => {
        // The focused card and the gallery wall are read on the cards themselves; a tooltip would only cover them.
        if (focus.node === node || (gallery && gallery.ids.has(String(node.id)))) return '';
        const title = node.title || node.name || 'Saved Entry';
        const key = getClusterKey(node);
        const cluster = key.startsWith('category:') ? '' : ' · ' + getClusterLabel(key);
        return escapeHtml(title + ' [' + getNodeCategory(node).toUpperCase() + ']' + cluster);
      })
      .nodeOpacity(BASE_NODE_OPACITY)
      .linkOpacity(BASE_LINK_OPACITY)
      .linkWidth(0)
      .linkDirectionalParticleSpeed(0.008)
      .linkDirectionalParticleWidth(0.6)
      .linkDirectionalParticleColor(() => particleColor)
      .onNodeClick(node => {
        // The second tap of a double tap (handled on release) may land on a card sliding past.
        if (ignoringClick()) return;
        lastBackgroundTap = null;
        if (linkPick) {
          pickLinkTarget(node);
          return;
        }
        if (playFromFace(node)) return;
        focusCard(node);
      })
      .onNodeHover(node => setHover(node, 'canvas'))
      .onBackgroundClick(handleBackgroundClick)
      .onEngineTick(onTerritoryTick)
      .onEngineStop(updateTerritories)
      .onNodeDragEnd(updateTerritories);

    document.getElementById('card-close').addEventListener('click', () => closeNodeCard());
    document.getElementById('card-prev').addEventListener('click', () => stepCarousel(-1));
    document.getElementById('card-next').addEventListener('click', () => stepCarousel(1));

    // Left/right arrows page through the cluster, unless typing or a dialog is open.
    document.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (document.querySelector('.modal-backdrop:not([hidden])') || !loginGate.hidden) return;
      // Carousel view: the arrows page the deck (and the open card follows it).
      if (filterState.view === 'carousel') {
        event.preventDefault();
        stepDeck(event.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      if (canStepCategories()) {
        event.preventDefault();
        stepCategory(delta);
        return;
      }
      if (nodeCard.style.display !== 'block' || cardCarousel.hidden) return;
      event.preventDefault();
      stepCarousel(delta);
    });

    // Touch: drag the sheet's handle/header down to close; swipe left/right anywhere on the card to page.
    const SWIPE_DISMISS_PX = 90;
    const SWIPE_EXPAND_PX = 40;
    const SWIPE_PAGE_PX = 60;
    let swipe = null;
    nodeCard.addEventListener('touchstart', event => {
      const target = event.target;
      if (event.touches.length !== 1 || target.closest('textarea, input, select, button, a, summary')) {
        swipe = null;
        return;
      }
      const touch = event.touches[0];
      swipe = { x: touch.clientX, y: touch.clientY, fromHandle: Boolean(target.closest('.card-handle, .card-head')) && compactLayout.matches };
    }, { passive: true });
    nodeCard.addEventListener('touchmove', event => {
      if (!swipe || !swipe.fromHandle) return;
      const dy = event.touches[0].clientY - swipe.y;
      nodeCard.classList.add('dragging');
      nodeCard.style.transform = dy > 0 ? 'translateY(' + dy + 'px)' : '';
    }, { passive: true });
    nodeCard.addEventListener('touchend', event => {
      if (!swipe) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      const fromHandle = swipe.fromHandle;
      swipe = null;
      nodeCard.classList.remove('dragging');
      if (fromHandle && dy > SWIPE_DISMISS_PX && dy > Math.abs(dx)) {
        nodeCard.style.transform = '';
        if (nodeCard.classList.contains('expanded')) nodeCard.classList.remove('expanded');
        else closeNodeCard();
        return;
      }
      if (fromHandle && -dy > SWIPE_EXPAND_PX && -dy > Math.abs(dx)) {
        nodeCard.style.transform = '';
        nodeCard.classList.add('expanded');
        return;
      }
      if (fromHandle && Math.abs(dx) < 8 && Math.abs(dy) < 8 && event.target.closest('.card-handle')) {
        nodeCard.classList.toggle('expanded');
        return;
      }
      // Anything short of a dismiss springs back.
      nodeCard.classList.add('settling');
      nodeCard.style.transform = '';
      setTimeout(() => nodeCard.classList.remove('settling'), 220);
      if (Math.abs(dx) > SWIPE_PAGE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) stepCarousel(dx < 0 ? 1 : -1);
    });
    nodeCard.addEventListener('touchcancel', () => {
      swipe = null;
      nodeCard.classList.remove('dragging');
      nodeCard.style.transform = '';
    });

    const graphControls = Graph.controls();
    graphControls.autoRotateSpeed = 0.5;
    graphControls.addEventListener('start', pauseAutoRotate);
    graphControls.addEventListener('end', scheduleResume);
    document.getElementById('3d-graph').addEventListener('pointerdown', event => {
      lastPointer = { x: event.clientX, y: event.clientY };
      pauseAutoRotate();
    });
    resumeAutoRotate();

    // ---- Camera rig (SPATIAL_ARCHITECTURE.md 2 and 5) ----
    // Every camera move is a goal for the damped rig in public/js/spatial/camera-rig.js. The rig outputs viewer poses
    // and a WebXR-ready viewer applies them (the camera sits in a dolly group). Grabbing the canvas mid-flight hands
    // the camera straight back to the orbit controls. Until the spatial modules load, moves use the library's tween.
    const NODE_DISTANCE = 90;
    const GROUP_MIN_DISTANCE = 42;
    // Stop 2 (Cluster) frames the cluster's bounding sphere at this margin: under 1, so its cards fill the view and the
    // outer ones run off the edges, rather than a small island far away.
    const CLUSTER_FIT_MARGIN = 0.85;
    // A focused card fills at most this share of the free part of the screen (width and height): big enough to read on
    // the card, with the arc around it still in view.
    const FOCUS_FILL_WIDE = { width: 0.58, height: 0.5 };
    // Phones have the whole width and most of the height above the sheet, so the card is framed large.
    const FOCUS_FILL_COMPACT = { width: 0.88, height: 0.62 };
    let FOCUS_FILL = compactLayout.matches ? FOCUS_FILL_COMPACT : FOCUS_FILL_WIDE;
    // Focused card size on screen: about 36% of the uncovered height, and at most FOCUS_FILL of the uncovered width.
    const getNodeDistance = cover => {
      if (!cardField) return NODE_DISTANCE;
      const spatial = window.AetherSpatial;
      const vFov = cameraFov();
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Graph.camera().aspect);
      const free = getFreeView(cover);
      const grown = 1.3;
      const byHeight = (spatial.CARD_HEIGHT * grown) / (2 * Math.tan(vFov / 2) * 0.36 * Math.max(free.height, 0.2));
      const byWidth = (spatial.CARD_WIDTH * grown) / (2 * Math.tan(hFov / 2) * FOCUS_FILL.width * Math.max(free.width, 0.2));
      return Math.max(byHeight, byWidth);
    };
    const FLAT_ORBIT = { theta: 0, phi: Math.PI / 2 };
    let cameraRig = null;
    let viewer = null;
    let rigFrame = 0;
    let rigLastTime = 0;
    const cameraFov = () => Graph.camera().fov * Math.PI / 180;
    const fitSphere = (radius, margin) => window.AetherSpatial
      ? window.AetherSpatial.fitSphereDistance(radius, cameraFov(), Graph.camera().aspect, margin)
      : radius * 2.5 + 60;
    // Viewing direction (theta, phi) around the look-at point: the rig's while it flies, else the camera's own.
    const getOrbit = () => {
      if (cameraRig && cameraRig.active) return { theta: cameraRig.current.theta, phi: cameraRig.current.phi };
      const camera = Graph.camera().position;
      const target = Graph.controls().target;
      const offset = { x: camera.x - target.x, y: camera.y - target.y, z: camera.z - target.z };
      const radius = Math.hypot(offset.x, offset.y, offset.z) || 1;
      return { theta: Math.atan2(offset.x, offset.z), phi: Math.acos(Math.min(1, Math.max(-1, offset.y / radius))) };
    };
    // Share of the canvas the open panels (node card, cluster drawer) cover: sidebars on the left and right edges on
    // wide screens ({ side: 'sides', left, right } as shares of the width); on phones, sheets across the top and bottom
    // ({ side: 'band', top, bottom } as shares of the height), leaving the band between them for the 3D view.
    // A panel's box where it comes to rest: its on-screen box less the offset of an entrance or exit still under way
    // (the translate property the panels ease in with), so the camera frames for where the panels end up.
    const restingRect = element => {
      const rect = element.getBoundingClientRect();
      const translate = getComputedStyle(element).translate;
      if (!translate || translate === 'none') return rect;
      const [x = 0, y = 0] = translate.split(' ').map(value => parseFloat(value) || 0);
      return x || y ? new DOMRect(rect.x - x, rect.y - y, rect.width, rect.height) : rect;
    };
    const getCardCover = () => {
      const canvas = Graph.renderer().domElement.getBoundingClientRect();
      if (!canvas.width || !canvas.height) return null;
      // On wide screens the group list is slid out in Atomic (body.zoom-atomic), so it covers nothing even while it is
      // still on its way out.
      const drawerCovers = clusterDrawer.classList.contains('open') && (compactLayout.matches || !document.body.classList.contains('zoom-atomic'));
      const panels = [nodeCard.style.display === 'block' ? nodeCard : null, drawerCovers ? clusterDrawer : null]
        .filter(Boolean).map(restingRect).filter(rect => rect.width && rect.height);
      if (!panels.length) return null;
      return compactLayout.matches
        ? (() => {
          // Only sheets that span the screen count; a narrow side panel on a small tablet leaves the band open.
          const sheets = panels.filter(rect => rect.width >= 0.6 * canvas.width);
          const middle = canvas.top + canvas.height / 2;
          const chrome = [document.getElementById('topbar'), document.getElementById('filter-toolbar')]
            .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height);
          const top = Math.max(0, ...sheets.filter(rect => rect.top + rect.height / 2 < middle).map(rect => rect.bottom - canvas.top),
            ...chrome.map(rect => rect.bottom - canvas.top)) / canvas.height;
          const bottom = Math.max(0, ...sheets.filter(rect => rect.top + rect.height / 2 >= middle).map(rect => canvas.bottom - rect.top)) / canvas.height;
          return { side: 'band', top, bottom, fraction: top + bottom };
        })()
        : (() => {
          const middle = canvas.left + canvas.width / 2;
          const left = Math.max(0, ...panels.filter(rect => rect.left + rect.width / 2 < middle).map(rect => rect.right - canvas.left)) / canvas.width;
          const right = Math.max(0, ...panels.filter(rect => rect.left + rect.width / 2 >= middle).map(rect => canvas.right - rect.left)) / canvas.width;
          return { side: 'sides', left, right, fraction: left + right };
        })();
    };
    // Share of the width and height the panels leave free, and where the free area's centre sits in normalised device
    // coordinates (centreX: -1 left edge to 1 right edge; centreY: -1 bottom to 1 top).
    const getFreeView = cover => {
      if (!cover) return { width: 1, height: 1, centreX: 0, centreY: 0 };
      if (cover.side === 'band') return { width: 1, height: Math.max(0.1, 1 - cover.top - cover.bottom), centreX: 0, centreY: cover.bottom - cover.top };
      if (cover.side === 'sides') return { width: Math.max(0.1, 1 - cover.left - cover.right), height: 1, centreX: cover.left - cover.right, centreY: 0 };
      const fraction = Math.min(cover.fraction, 0.9);
      return cover.side === 'bottom'
        ? { width: 1, height: Math.max(0.1, 1 - fraction), centreX: 0, centreY: fraction }
        : { width: Math.max(0.1, 1 - fraction), height: 1, centreX: -fraction, centreY: 0 };
    };

    const finishFlight = () => {
      cancelAnimationFrame(rigFrame);
      rigFrame = 0;
      rigLastTime = 0;
      const controls = Graph.controls();
      controls.enabled = true;
      controls.update();
    };
    const stepRig = time => {
      const dt = rigLastTime ? (time - rigLastTime) / 1000 : 1 / 60;
      rigLastTime = time;
      const pose = cameraRig.update(dt);
      if (pose) viewer.applyPose(pose);
      if (cameraRig.active) rigFrame = requestAnimationFrame(stepRig);
      else finishFlight();
    };
    // ---- Spatial zoom stops (public/js/spatial/zoom-stops.js): Space (the whole cloud), Cluster (one island), Horizon (its
    // 180-degree wall, the default on launch) and Atomic (one card). The slider and the mouse wheel move between them;
    // every camera move reports the stop it lands on, so the slider always shows where the view is. ----
    const ZOOM_STOP_ORDER = ['space', 'cluster', 'horizon', 'atomic'];
    const ZOOM_STOP_NAMES = { space: 'Space', cluster: 'Cluster', horizon: 'Horizon', atomic: 'Atomic' };
    // Free zoom in Space and Cluster steps to the next stop past these multiples of the stop's own framing distance.
    const STOP_PUSH_IN = 0.6;
    const STOP_PULL_BACK = 1.8;
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomStopLabels = [...document.querySelectorAll('.zoom-stops [data-stop]')];
    let zoomStop = 'space';
    // The cluster the last Cluster framing was for, and its distance.
    let clusterFrame = null;
    const renderZoomStop = () => {
      syncThumbWheel();
      zoomSlider.value = String(ZOOM_STOP_ORDER.indexOf(zoomStop));
      zoomSlider.setAttribute('aria-valuetext', ZOOM_STOP_NAMES[zoomStop]);
      zoomStopLabels.forEach(label => label.classList.toggle('active', label.dataset.stop === zoomStop));
    };
    renderZoomStop();
    const setAtomicLayout = on => document.body.classList.toggle('zoom-atomic', on);
    const noteZoomStop = state => {
      const next = state === 'macro' ? 'space' : state === 'node' ? 'atomic' : gallery ? 'horizon' : 'cluster';
      if (next !== 'atomic') setAtomicLayout(false);
      if (next === zoomStop) return;
      zoomStop = next;
      renderZoomStop();
    };

    // goal: { target, distance, theta?, phi?, state, detail?, instant? }; theta/phi default to the current direction.
    const cameraGoTo = goal => {
      if (goal.state) noteZoomStop(goal.state);
      // In a headset the viewer is placed by the XR session (teleports and the gallery), never flown.
      if (viewer && viewer.isPresenting()) return;
      pauseAutoRotate();
      if (!cameraRig) {
        const camera = Graph.camera().position;
        const t = goal.target;
        let dir = { x: camera.x - t.x, y: camera.y - t.y, z: camera.z - t.z };
        if (goal.theta !== undefined || goal.phi !== undefined) {
          const theta = goal.theta ?? 0;
          const phi = goal.phi ?? Math.PI / 2;
          dir = { x: Math.sin(phi) * Math.sin(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.cos(theta) };
        }
        const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
        const k = goal.distance / length;
        Graph.cameraPosition({ x: t.x + dir.x * k, y: t.y + dir.y * k, z: t.z + dir.z * k }, t, goal.instant ? 0 : 1000);
        return;
      }
      const pose = cameraRig.goTo(goal, viewer.currentPose());
      if (pose) {
        viewer.applyPose(pose);
        return;
      }
      Graph.controls().enabled = false;
      if (!rigFrame) rigFrame = requestAnimationFrame(stepRig);
    };
    const cancelCameraFlight = () => {
      if (!cameraRig || !cameraRig.active) return;
      cameraRig.cancel();
      finishFlight();
    };
    // Capture phase: runs before the orbit controls see the press, so they take over in the same gesture.
    graphElement.addEventListener('pointerdown', cancelCameraFlight, { capture: true, passive: true });
    graphElement.addEventListener('pointerup', event => {
      if (event.button !== 0) return;
      const point = { x: event.clientX, y: event.clientY };
      if (isSecondTap(point)) {
        ignoreClickUntil = Date.now() + 500;
        lastTapUp = { time: 0, point: null };
        finishDoubleTap();
        return;
      }
      lastTapUp = { time: Date.now(), point };
    }, { capture: true, passive: true });
    graphElement.addEventListener('wheel', cancelCameraFlight, { capture: true, passive: true });

    const initCameraRig = () => {
      if (cameraRig || !window.AetherSpatial) return;
      cameraRig = new window.AetherSpatial.CameraRig({ reducedMotion: reducedMotion.matches });
      viewer = window.AetherSpatial.createViewer({ camera: Graph.camera(), controls: Graph.controls() });
      if (THREE) viewer.attachDolly(THREE, Graph.scene());
      setupXR();
    };
    if (window.AetherSpatial) initCameraRig();
    else window.addEventListener('aether-spatial-ready', initCameraRig, { once: true });

    // Card field: built once three.js and the spatial modules are both in. The field places every card each frame from
    // the simulated node positions (plus gallery and focus offsets), so the graph's own position writes are skipped.
    let cardFrame = 0;
    let cardLastTime = 0;
    // One card-field step; the page's own requestAnimationFrame loop runs it on screens and the XR session's frame
    // loop in a headset (where the window's animation frames stop).
    const cardStep = time => {
      const dt = cardLastTime ? Math.min(0.1, (time - cardLastTime) / 1000) : 1 / 60;
      cardLastTime = time;
      if (filterState.view === 'graph') {
        cardField.frame(dt, Graph.camera());
        updateWires();
        const showLabels = !focus.node && !gallery;
        territories.entries.forEach((entry, key) => {
          const visible = showLabels && entry.hasNodes !== false && cardField.clusterLod(key) < 0.5;
          // Hidden labels must also stop taking clicks (raycasts ignore visibility), or they swallow taps on cards.
          if (entry.label.visible !== visible) entry.label.layers.set(visible ? 0 : cardField.hiddenLayer);
          entry.label.visible = visible;
          const scale = labelScale();
          if (entry.label.scale.y !== LABEL_HEIGHT * scale) entry.label.scale.set(LABEL_WIDTH * scale, LABEL_HEIGHT * scale, 1);
        });
      }
    };
    // 1 on screens; in a headset, whatever makes a label XR_LABEL_HEIGHT_M tall. three.js applies a sprite's size in the
    // camera's own units, and with the world scaled down around the viewer those are metres, so the size is given in
    // metres directly (not in graph units, which made labels metres high).
    const labelScale = () => {
      if (!(viewer && viewer.isPresenting())) return 1;
      return XR_LABEL_HEIGHT_M / LABEL_HEIGHT;
    };
    const cardLoop = time => {
      if (!(viewer && viewer.isPresenting())) cardStep(time);
      cardFrame = requestAnimationFrame(cardLoop);
    };
    const initCards = () => {
      if (cardField || !THREE || !window.AetherSpatial) return;
      const spatial = window.AetherSpatial;
      cardField = spatial.createCardField({ THREE, reducedMotion: reducedMotion.matches });
      // The library's node dragging grabs any press that lands on a card and switches the orbit controls off for it,
      // which froze swipes in the gallery (where cards fill the view). Cards are placed by the card field every
      // frame, so dragging them in 3D is off; Board view keeps its own drag. Set before nodeThreeObject, whose
      // update rebuilds the library's drag controls.
      Graph
        .enableNodeDrag(false)
        .nodeThreeObject(node => {
          const card = cardField.build(node, getCardFace(node));
          cardField.setTargets(node.id, getCardTargets(node));
          return card;
        })
        .nodePositionUpdate(() => true);
      // Cards are wider than the old points: keep them from overlapping (radius = half the card's diagonal).
      Graph.d3Force('collide', spatial.createCollideForce(Math.hypot(spatial.CARD_WIDTH, spatial.CARD_HEIGHT) / 2));
      Graph.scene().add(cardField.proxyRoot);
      cardField.setLodMode(getLodMode());
      updateTerritories();
      Graph.d3ReheatSimulation();
      if (!cardFrame) cardFrame = requestAnimationFrame(cardLoop);
    };
    window.addEventListener('aether-spatial-ready', initCards, { once: true });

    // ---- 180-degree gallery (SPATIAL_ARCHITECTURE.md 6): opening a group in 3D lays its cards on a half cylinder around
    // a standpoint at the cluster's centre. On screens (stop 3, Zoom) the camera stands inside the arc, a little above
    // eye level, looking at one card on the wall from close enough that it fills the middle of the free view while the
    // next cards only just show at the edges (arcFraming in zoom-stops.js, which also widens the wall for that).
    // Dragging slides the view along the wall and settles on the nearest card; the orbit controls' own rotate, pan and
    // zoom are off. ----
    let savedControls = null;
    // Cards per row on the wall (galleryLayout's default) and a card plus its gap along the arc.
    const GALLERY_PER_ROW = 9;
    const GALLERY_PITCH = 1.15;
    // In stop 3 a hovered card slides this share of the viewing distance toward the viewer; in stop 4 the focused card
    // slides this share of its framing distance.
    const ARC_HOVER_SLIDE = 0.1;
    const ATOMIC_SLIDE = 0.15;
    // Stop 4: the card fills most of the free part of the view.
    const ATOMIC_FILL = { width: 0.88, height: 0.86 };
    // The widest a card is framed on the wall, in CSS pixels (stop 3 for the card in front, stop 4 for the open card).
    // On a wide screen the fill shares above would stretch a card across most of the view and blow its face texture up
    // past its pixels; capped, it stays centred with the dark space around it, and its hero face (1536 px wide) still
    // lands at about one texel per device pixel on a 2x display.
    const HORIZON_MAX_CARD_PX = 680;
    const ATOMIC_MAX_CARD_PX = 760;
    // Camera distance at which a card width world units wide spans maxPx CSS pixels of the canvas (0 when unknown).
    const cappedCardDistance = (width, maxPx) => {
      const canvasWidth = Graph.renderer().domElement.clientWidth;
      if (!canvasWidth) return 0;
      const tanH = Math.tan(cameraFov() / 2) * Graph.camera().aspect;
      return (width * canvasWidth) / (2 * tanH * maxPx);
    };
    // Room kept between the top bar (and filter row) and the top of a card on the wall, in pixels.
    const WALL_TOP_GAP_PX = 14;
    // The part of the view a card on the wall is framed in (stops 3 and 4): what the panels leave free, and on wide
    // screens also below the top bar and filter row, which float over the canvas (on phones the band between the sheets
    // already starts below them). Same shape as getFreeView: shares of the width and height, centre in device units.
    const getWallView = (cover = getCardCover()) => {
      const free = getFreeView(cover);
      if (compactLayout.matches) return free;
      const canvasHeight = Graph.renderer().domElement.clientHeight || window.innerHeight;
      const top = getTopChrome() + WALL_TOP_GAP_PX / canvasHeight;
      const upper = Math.min(free.centreY + free.height, 1 - 2 * top);
      const lower = free.centreY - free.height;
      return { ...free, height: Math.max(0.1, (upper - lower) / 2), centreY: (upper + lower) / 2 };
    };
    const lockGalleryControls = on => {
      const controls = Graph.controls();
      if (on && !savedControls) {
        savedControls = { min: controls.minPolarAngle, max: controls.maxPolarAngle, zoom: controls.enableZoom, pan: controls.enablePan, rotate: controls.enableRotate };
        controls.minPolarAngle = Math.PI / 2;
        controls.maxPolarAngle = Math.PI / 2;
        controls.enableZoom = false;
        controls.enablePan = false;
        // Desktop drags slide along the wall and phones swipe from card to card (both below), not the orbit controls.
        controls.enableRotate = false;
      } else if (!on && savedControls) {
        controls.minPolarAngle = savedControls.min;
        controls.maxPolarAngle = savedControls.max;
        controls.enableZoom = savedControls.zoom;
        controls.enablePan = savedControls.pan;
        controls.enableRotate = savedControls.rotate;
        savedControls = null;
      }
    };
    // Stop 3 framing for a wall of count cards with the panels open now: { radius, distance } (arcFraming).
    // minRadius keeps a wall that is already up from shrinking.
    const arcFramingFor = (count, minRadius = 0) => {
      const spatial = window.AetherSpatial;
      const free = getWallView();
      const tanV = Math.tan(cameraFov() / 2);
      const tanH = tanV * Graph.camera().aspect;
      const perRow = Math.max(1, Math.min(count, GALLERY_PER_ROW));
      return spatial.arcFraming({
        cardWidth: spatial.CARD_WIDTH,
        cardHeight: spatial.CARD_HEIGHT,
        perRow,
        minRadius: Math.max(minRadius, (perRow * spatial.CARD_WIDTH * GALLERY_PITCH) / Math.PI),
        tanHalfWidth: tanH * free.width,
        tanHalfHeight: tanV * free.height,
        minDistance: cappedCardDistance(spatial.CARD_WIDTH, HORIZON_MAX_CARD_PX)
      });
    };
    const arcDistance = () => arcFramingFor(gallery.ids.size, gallery.radius).distance;
    // Camera goal looking at the wall at look ({ yaw, y }) from distance, shifted so that point lands in the middle of
    // the part of the screen the panels leave free (between the sidebars, or mid-way up the band between phone sheets).
    const arcPose = (look, distance) => {
      const free = getWallView();
      const tanV = Math.tan(cameraFov() / 2);
      const tanH = tanV * Graph.camera().aspect;
      return window.AetherSpatial.wallPose({
        origin: gallery.origin,
        radius: gallery.radius,
        yaw: look.yaw,
        y: look.y,
        distance,
        shift: { x: free.centreX * distance * tanH, y: free.centreY * distance * tanV }
      });
    };
    // Stop 3: back to the wall framing at the current look, card unfocused.
    const flyToArc = (options = {}) => {
      if (!gallery || xrPresenting()) return;
      // The group list is back (it steps aside in stop 4) before the framing measures the room.
      setAtomicLayout(false);
      const distance = arcDistance();
      // Remembered for stop 4, which must come nearer than this.
      gallery.arcDistance = distance;
      cardField.setGallerySlide(distance * ARC_HOVER_SLIDE);
      cameraGoTo({ ...arcPose(gallery.look, distance), state: 'group', detail: gallery.key, ...options });
    };
    // Where the wall slot of card id is looked at from: { yaw, y }.
    const lookAtSlot = id => {
      const slot = cardField.galleryPosition(id);
      return slot ? { yaw: window.AetherSpatial.yawToward(gallery.origin, slot), y: slot.y } : null;
    };
    // The card in the middle of the wall (the one a new wall centres on): the smallest turn from the facing, middle row.
    const frontSlotLook = placed => {
      const slots = placed.layout.slots.filter(slot => slot.page === 0);
      if (!slots.length) return { yaw: placed.yaw, y: placed.origin.y };
      const front = slots.reduce((best, slot) => (Math.abs(slot.angle) + Math.abs(slot.local.y) * 0.01 < Math.abs(best.angle) + Math.abs(best.local.y) * 0.01 ? slot : best));
      return { yaw: placed.yaw + front.angle, y: placed.origin.y + front.local.y };
    };
    const galleryIds = key => getClusterNodes(key).filter(node => Number.isFinite(node.x)).map(node => node.id);
    // Centre of a cluster: the island label's, or the members' own centroid for a cluster that has no label position
    // yet (a brand-new group).
    const getClusterCenter = key => {
      const entry = territories.entries.get(key);
      if (entry && entry.center) return { ...entry.center };
      const nodes = getClusterNodes(key).filter(node => [node.x, node.y, node.z].every(Number.isFinite));
      if (!nodes.length) return null;
      const center = { x: 0, y: 0, z: 0 };
      nodes.forEach(node => { center.x += node.x; center.y += node.y; center.z += node.z; });
      return { x: center.x / nodes.length, y: center.y / nodes.length, z: center.z / nodes.length };
    };
    const enterGallery = (key, centerId = null) => {
      if (!cardField || filterState.flat || filterState.view !== 'graph') return;
      const ids = galleryIds(key);
      const origin = getClusterCenter(key);
      if (!origin || !ids.length) return;
      const camera = Graph.camera().position;
      const yaw = window.AetherSpatial.yawToward(camera, origin);
      // In a headset the arc is wider, so a card on it is a comfortable size rather than filling the view; on screens
      // it is as wide as stop 3's framing asks.
      const minRadius = xrPresenting() ? XR_GALLERY_MIN_RADIUS : arcFramingFor(ids.length).radius;
      const placed = cardField.enterGallery(ids, { origin, yaw, centerId, minRadius });
      // homeLook: where Home turns the view back to (the middle card).
      const look = frontSlotLook(placed);
      gallery = { key, origin, yaw, radius: placed.radius, ids: placed.ids, look, homeLook: look };
      startGalleryNav();
      syncCards();
      Graph.linkVisibility(link => !gallery || !(gallery.ids.has(linkEndId(link.source)) || gallery.ids.has(linkEndId(link.target))));
      if (territories.group) territories.group.visible = false;
      pauseAutoRotate();
      lockGalleryControls(true);
      flyToArc();
    };
    // Filters or group changes while the gallery is open re-slot its cards without moving the camera.
    const refreshGallery = (centerId = null) => {
      if (!gallery) return;
      const ids = galleryIds(gallery.key);
      if (!ids.length) {
        exitGallery();
        return;
      }
      const minRadius = xrPresenting() ? XR_GALLERY_MIN_RADIUS : Math.max(gallery.radius, arcFramingFor(ids.length).radius);
      const placed = cardField.enterGallery(ids, { origin: gallery.origin, yaw: gallery.yaw, centerId, minRadius });
      gallery.ids = placed.ids;
      gallery.radius = placed.radius;
      if (centerId !== null) gallery.look = gallery.homeLook = frontSlotLook(placed);
      if (!focus.node && !xrPresenting()) cardField.setGallerySlide(arcDistance() * ARC_HOVER_SLIDE);
      syncCards();
    };
    // ---- Gallery arrows: step to the previous or next card along the wall (its display order runs row by row, left to
    // right). With no card focused yet, the first press focuses the card straight ahead. ----
    const galleryNav = document.getElementById('gallery-nav');
    const galleryPrevButton = document.getElementById('gallery-prev');
    const galleryNextButton = document.getElementById('gallery-next');
    // Space between the two arrows, and above the bottom of the free area: clear of the controls hint on desktop; on
    // phones the band between the sheets is short, and the focused card fills only its middle half (FOCUS_FILL), so
    // the arrows sit just above the lower sheet.
    const GALLERY_NAV_GAP = 24;
    const GALLERY_NAV_BOTTOM = 40;
    const GALLERY_NAV_BOTTOM_COMPACT = 8;
    const GALLERY_NAV_SIZE = 44;
    // Clear of the top bar and filter toolbar.
    const GALLERY_NAV_MIN_TOP = 130;
    const aheadGalleryIndex = ids => {
      const camera = Graph.camera().position;
      const target = Graph.controls().target;
      const look = { x: target.x - camera.x, y: target.y - camera.y, z: target.z - camera.z };
      let best = 0;
      let bestScore = -Infinity;
      ids.forEach((id, index) => {
        const slot = cardField.galleryPosition(id);
        if (!slot) return;
        const to = { x: slot.x - camera.x, y: slot.y - camera.y, z: slot.z - camera.z };
        const score = (look.x * to.x + look.y * to.y + look.z * to.z) / (Math.hypot(to.x, to.y, to.z) || 1);
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      });
      return best;
    };
    // In stop 4 the arrows and swipes focus the next card; in stop 3 they slide the view to it without opening it.
    const stepGallery = delta => {
      if (!gallery || !cardField) return;
      const ids = [...gallery.ids];
      const count = ids.length;
      if (!count) return;
      const current = focus.node && gallery.ids.has(String(focus.node.id)) ? String(focus.node.id) : null;
      const index = current ? ids.indexOf(current) : aheadGalleryIndex(ids);
      const visible = new Map(Graph.graphData().nodes.map(item => [String(item.id), item]));
      for (let step = 1; step < count; step++) {
        const next = visible.get(ids[((index + delta * step) % count + count) % count]);
        if (!next) continue;
        if (current) {
          focusCard(next);
        } else {
          const look = lookAtSlot(next.id);
          if (look) gallery.look = look;
          flyToArc();
        }
        return;
      }
    };
    // The card straight ahead on the wall, or null.
    const aheadGalleryNode = () => {
      if (!gallery || !cardField) return null;
      const ids = [...gallery.ids];
      if (!ids.length) return null;
      const id = ids[aheadGalleryIndex(ids)];
      return Graph.graphData().nodes.find(item => String(item.id) === id) || null;
    };
    // ---- Desktop drag in stop 3: the view slides along the wall with the pointer and settles on the nearest card ----
    const ARC_DRAG_PX = 4;
    let arcDrag = null;
    graphElement.addEventListener('pointerdown', event => {
      arcDrag = gallery && !focus.node && !compactLayout.matches && !xrPresenting() && event.isPrimary && event.button === 0
        ? { x: event.clientX, yaw: gallery.look.yaw, moved: false }
        : null;
    }, { capture: true, passive: true });
    window.addEventListener('pointermove', event => {
      if (!arcDrag || !gallery) return;
      const dx = event.clientX - arcDrag.x;
      if (!arcDrag.moved && Math.abs(dx) < ARC_DRAG_PX) return;
      arcDrag.moved = true;
      // One pixel moves the wall point under the pointer by the width a pixel covers at the viewing distance.
      const width = Graph.renderer().domElement.clientWidth || 1;
      const tanH = Math.tan(cameraFov() / 2) * Graph.camera().aspect;
      const distance = arcDistance();
      const perPixel = (2 * distance * tanH) / width / gallery.radius;
      const limit = Math.PI / 2;
      const yaw = Math.max(gallery.yaw - limit, Math.min(gallery.yaw + limit, arcDrag.yaw - dx * perPixel));
      gallery.look = { yaw, y: gallery.look.y };
      cameraGoTo({ ...arcPose(gallery.look, distance), state: 'group', detail: gallery.key, instant: true });
    }, { passive: true });
    const endArcDrag = () => {
      const drag = arcDrag;
      arcDrag = null;
      if (!drag || !drag.moved || !gallery) return;
      ignoreClickUntil = Date.now() + 300;
      // Settle on the card nearest the middle of the view, in the row being looked at.
      let best = null;
      gallery.ids.forEach(id => {
        const look = lookAtSlot(id);
        if (!look) return;
        const score = Math.abs(Math.atan2(Math.sin(look.yaw - gallery.look.yaw), Math.cos(look.yaw - gallery.look.yaw))) + Math.abs(look.y - gallery.look.y) * 0.05;
        if (!best || score < best.score) best = { look, score };
      });
      if (best) gallery.look = best.look;
      flyToArc();
    };
    window.addEventListener('pointerup', endArcDrag, { passive: true });
    window.addEventListener('pointercancel', endArcDrag, { passive: true });
    // With a wall up the arrows step along it; otherwise (an open card on the Board, or one opened without a wall) they
    // page the card through its cluster, as a sideways swipe on the card does.
    const stepCards = delta => {
      if (gallery) stepGallery(delta);
      else if (canStepCategories()) stepCategory(delta);
      else stepCarousel(delta);
    };
    galleryPrevButton.addEventListener('click', () => stepCards(-1));
    galleryNextButton.addEventListener('click', () => stepCards(1));
    let galleryNavFrame = 0;
    const placeGalleryNav = () => {
      galleryNavFrame = 0;
      const canvas = Graph.renderer().domElement.getBoundingClientRect();
      const cardSteps = !gallery && Boolean(focus.node) && nodeCard.style.display === 'block' && carousel.ids.length > 1;
      const categorySteps = canStepCategories();
      const show = (gallery ? gallery.ids.size > 1 : cardSteps || categorySteps) && filterState.view === 'graph' && canvas.width > 0;
      galleryNav.hidden = !show;
      if (!show) return;
      const what = categorySteps ? 'category' : 'card';
      if (galleryNav.dataset.steps !== what) {
        galleryNav.dataset.steps = what;
        galleryPrevButton.title = 'Previous ' + what + ' (swipe right)';
        galleryPrevButton.setAttribute('aria-label', 'Previous ' + what);
        galleryNextButton.title = 'Next ' + what + ' (swipe left)';
        galleryNextButton.setAttribute('aria-label', 'Next ' + what);
      }
      // Side by side at the bottom of the free part of the screen, in the dark space below the wall, so they never sit
      // on top of a card's picture.
      const free = getFreeView(getCardCover());
      const centreX = canvas.left + canvas.width * (1 + free.centreX) / 2;
      let freeBottom = canvas.top + canvas.height * (1 - free.centreY + free.height) / 2;
      // Phones: the group list's small tab sits in the bottom-left corner (it does not count as a covering sheet), so
      // the arrows stand just above it.
      if (compactLayout.matches && clusterDrawer.classList.contains('open') && !clusterDrawer.classList.contains('expanded')) {
        const tab = clusterDrawer.getBoundingClientRect();
        if (tab.height) freeBottom = Math.min(freeBottom, tab.top - 4 + GALLERY_NAV_BOTTOM_COMPACT);
      }
      const top = Math.round(Math.max(canvas.top + GALLERY_NAV_MIN_TOP, freeBottom - (compactLayout.matches ? GALLERY_NAV_BOTTOM_COMPACT : GALLERY_NAV_BOTTOM) - GALLERY_NAV_SIZE)) + 'px';
      galleryPrevButton.style.top = top;
      galleryNextButton.style.top = top;
      galleryPrevButton.style.left = Math.round(centreX - GALLERY_NAV_GAP / 2 - GALLERY_NAV_SIZE) + 'px';
      galleryNextButton.style.left = Math.round(centreX + GALLERY_NAV_GAP / 2) + 'px';
      galleryNavFrame = requestAnimationFrame(placeGalleryNav);
    };
    const startGalleryNav = () => {
      if (!galleryNavFrame) galleryNavFrame = requestAnimationFrame(placeGalleryNav);
    };
    // ---- Swipe scopes (2026-10-01): a sideways swipe on the 3D view steps cards within the group on the wall, as the
    // ◀ ▶ arrows do (swipe left: next card). Changing group is a swipe on the Categories bar or the group tab, the two
    // overlays in the bottom-left corner: it flies in the next (swipe left) or previous (swipe right) group at the same
    // stop, with no zoom out: the next island framed, its wall put up, or its newest card opened on its wall. Groups
    // run in order around the scene's vertical axis, so going on swiping one way tours every group and comes back round.
    // On the 3D view: a quick, clearly sideways touch flick (a slower one-finger drag still turns the view in Cluster),
    // a mouse drag in Atomic, where dragging does nothing else (in Horizon it slides along the wall; in Cluster it
    // orbits), or a trackpad's two-finger sideways swipe (the wheel handler below). Without a wall up there is no card
    // to step to, so a swipe on the view does nothing.
    const GROUP_SWIPE_PX = 60;
    const GROUP_SWIPE_MS = 450;
    const GROUP_SWIPE_STOPS = ['cluster', 'horizon', 'atomic'];
    // The Categories bar and the group tab are small, so a shorter swipe counts there.
    const BAR_SWIPE_PX = 40;
    // The groups with cards on screen, in order of their direction from the scene's centre (a turn about the vertical).
    const orderedGroupKeys = () => {
      const keys = [];
      territories.entries.forEach((entry, key) => {
        if (entry.center && newestIn(key)) keys.push({ key, angle: Math.atan2(entry.center.x, entry.center.z) });
      });
      return keys.sort((a, b) => a.angle - b.angle || a.key.localeCompare(b.key)).map(item => item.key);
    };
    // The group the view is on: its wall, the open card's, or the framed cluster.
    const currentGroupKey = () => gallery ? gallery.key : focus.node ? wallKeyOf(focus.node) : clusterFrame ? clusterFrame.key : null;
    const swipeGroup = delta => {
      if (filterState.view !== 'graph' || filterState.flat || xrPresenting() || !GROUP_SWIPE_STOPS.includes(zoomStop)) return false;
      const keys = orderedGroupKeys();
      if (!keys.length) return false;
      const current = currentGroupKey();
      const index = keys.indexOf(current);
      // From an Outcome's own wall (not an island), the first group in the order.
      const key = index < 0 ? keys[0] : keys[((index + delta) % keys.length + keys.length) % keys.length];
      if (key === current) return false;
      cancelPendingFit();
      const newest = newestIn(key);
      if (zoomStop === 'cluster') {
        if (focus.node) hideNodeCard();
        flyToCluster(key);
      } else if (zoomStop === 'horizon') {
        if (focus.node) hideNodeCard();
        openClusterDrawer(key, { centerId: newest ? newest.id : null });
      } else if (newest) {
        focusCard(newest, { centre: true });
      }
      return true;
    };
    // Highlighted categories (two or more, picked in the legend) are toured in legend order: with no card or wall open, a
    // sideways swipe on the 3D view, the ◀ ▶ arrows, a trackpad's sideways flick and the ← → keys fly to the next one.
    const highlightedCategories = () => {
      const present = new Set(Graph.graphData().nodes.map(getNodeCategory));
      return [...filterState.highlighted].filter(category => present.has(category)).sort((a, b) => legendRank(a) - legendRank(b) || a.localeCompare(b));
    };
    const canStepCategories = () => filterState.view === 'graph' && !filterState.flat && !xrPresenting() && !gallery && !focus.node && highlightedCategories().length > 1;
    const stepCategory = delta => {
      if (!canStepCategories()) return false;
      const categories = highlightedCategories();
      const current = clusterFrame && clusterFrame.key.indexOf('category:') === 0 ? clusterFrame.key.slice('category:'.length) : null;
      const index = categories.indexOf(current);
      const next = index < 0 ? categories[delta > 0 ? 0 : categories.length - 1] : categories[((index + delta) % categories.length + categories.length) % categories.length];
      cancelPendingFit();
      flyToCategory(next);
      return true;
    };
    // The next or previous card on the wall, as the arrows step (false with no wall up, or a wall of one card).
    const swipeCard = delta => {
      if (filterState.view !== 'graph' || filterState.flat || xrPresenting() || !gallery || gallery.ids.size < 2) return false;
      stepGallery(delta);
      return true;
    };
    let cardSwipe = null;
    graphElement.addEventListener('pointerdown', event => {
      // A second finger (a pinch) is never a swipe.
      if (!event.isPrimary) {
        cardSwipe = null;
        return;
      }
      const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
      const eligible = (gallery && GROUP_SWIPE_STOPS.includes(zoomStop) && !filterState.flat && !xrPresenting()
        && (touch || (event.pointerType === 'mouse' && event.button === 0 && zoomStop === 'atomic')))
        || (touch && canStepCategories());
      cardSwipe = eligible ? { x: event.clientX, y: event.clientY, time: Date.now(), touch } : null;
    }, { capture: true, passive: true });
    graphElement.addEventListener('pointerup', event => {
      const start = cardSwipe;
      cardSwipe = null;
      // A desktop drag along the wall is a slide, not a swipe.
      if (!start || !event.isPrimary || (arcDrag && arcDrag.moved)) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if ((start.touch && Date.now() - start.time > GROUP_SWIPE_MS) || Math.abs(dx) < GROUP_SWIPE_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
      const delta = dx < 0 ? 1 : -1;
      if (!swipeCard(delta) && !stepCategory(delta)) return;
      ignoreClickUntil = Date.now() + 500;
      lastBackgroundTap = null;
    }, { capture: true, passive: true });
    graphElement.addEventListener('pointercancel', () => { cardSwipe = null; }, { passive: true });
    // Group swipes on the Categories bar and the group tab. Touch events, as on the card sheet: a sideways drag there
    // may be taken by the browser as a pan, which cancels pointer events but still ends the touch. A row of category
    // chips that scrolls sideways (phones, many categories) keeps its own scrolling; a swipe on the pill below it
    // still changes group.
    const bindGroupSwipe = element => {
      let start = null;
      let suppressClickUntil = 0;
      element.addEventListener('touchstart', event => {
        const target = event.target;
        const row = target.closest('#legend-items');
        const scrolls = row && row.scrollWidth > row.clientWidth + 1;
        start = event.touches.length === 1 && !scrolls && !target.closest('input, textarea, select')
          ? { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now() }
          : null;
      }, { passive: true });
      element.addEventListener('touchend', event => {
        const begun = start;
        start = null;
        if (!begun) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - begun.x;
        const dy = touch.clientY - begun.y;
        if (Date.now() - begun.time > GROUP_SWIPE_MS || Math.abs(dx) < BAR_SWIPE_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
        // The swipe must not also toggle a chip, the Categories list or the group tab.
        if (swipeGroup(dx < 0 ? 1 : -1)) suppressClickUntil = Date.now() + 400;
      }, { passive: true });
      element.addEventListener('touchcancel', () => { start = null; }, { passive: true });
      element.addEventListener('click', event => {
        if (Date.now() >= suppressClickUntil) return;
        event.preventDefault();
        event.stopPropagation();
      }, { capture: true });
    };
    bindGroupSwipe(legend);
    bindGroupSwipe(clusterDrawer.querySelector('.drawer-head'));

    const exitGallery = (options = {}) => {
      if (!gallery) return;
      const key = gallery.key;
      gallery = null;
      cardField.exitGallery();
      syncCards();
      Graph.linkVisibility(!filterState.flat);
      lockGalleryControls(false);
      if (territories.group) territories.group.visible = !focus.node && !filterState.flat;
      if (filterState.view === 'graph' && options.fly !== false) flyToCluster(key);
    };

    // Universal focus (2026-09-27): selecting a card in the 3D graph, in any time scope, opens its cluster as the
    // 180-degree gallery with the card focused. A new gallery is centred on the card; in a gallery already open on that
    // cluster the camera turns to the card instead of reshuffling the wall (unless centre is asked for). 2D mode and
    // the moment before the cards load keep the plain close-up.
    const focusCard = (node, options = {}) => {
      const { centre = false, ...selectOptions } = options;
      const placed = [node.x, node.y, node.z].every(Number.isFinite);
      if (cardField && placed && !filterState.flat && filterState.view === 'graph') {
        const onWall = gallery && gallery.ids.has(String(node.id));
        const key = getNodeCategory(node) === 'outcome' ? 'outcome:' + node.id : onWall && !centre ? gallery.key : getClusterKey(node);
        if (!gallery || gallery.key !== key) openClusterDrawer(key, { centerId: node.id });
        else if (centre) refreshGallery(node.id);
      }
      selectNode(node, { ...selectOptions, fly: true });
    };

    // Post-creation framing: a card that was just added (Add Node, or the share sheet's View Node link) opens straight
    // into its group's 180-degree gallery, centred on the wall and focused, rather than the whole graph. It waits up to
    // 2 s for the graph to build the card and give it a position; in 2D, or before the cards load, it falls back to the
    // plain close-up.
    // The swoop starts only once the card has been built and has stopped drifting (under SETTLE_SPEED world units per
    // frame for SETTLE_FRAMES frames in a row), so the camera lands where the card ends up. If it is still moving after
    // waitMs, it goes anyway; a gallery pins its cards to the wall.
    const SETTLE_SPEED = 0.5;
    const SETTLE_FRAMES = 12;
    const focusNewNode = (id, waitMs = 2000) => {
      if (filterState.view !== 'graph') setView('graph');
      // A pending whole-graph framing would pull the camera back out after the swoop.
      cancelPendingFit();
      const started = performance.now();
      let last = null;
      let still = 0;
      const attempt = () => {
        const node = Graph.graphData().nodes.find(item => String(item.id) === String(id));
        const placed = node && [node.x, node.y, node.z].every(Number.isFinite);
        const built = placed && (!cardField || cardField.has(node.id));
        if (built) {
          still = last && Math.hypot(node.x - last.x, node.y - last.y, node.z - last.z) < SETTLE_SPEED ? still + 1 : 0;
          last = { x: node.x, y: node.y, z: node.z };
        }
        const timedOut = performance.now() - started >= waitMs;
        if (built && (still >= SETTLE_FRAMES || timedOut)) {
          focusCard(node, { centre: true });
          return;
        }
        if (!timedOut) requestAnimationFrame(attempt);
        else if (placed) selectNode(node, { fly: true });
      };
      requestAnimationFrame(attempt);
    };

    // ---- Time scope and semantic zoom (SPATIAL_ARCHITECTURE.md 2.7) ----
    // The portal opens on a small, recent set of cards and widens its time span step by step: with the stepper in the
    // filter toolbar, or by pulling the camera well back past the framing of what is shown.
    // 'groups' is all time with every cluster collapsed into its group proxy (section 2.5).
    const SCOPES = ['day', 'week', 'month', 'groups', 'all'];
    const SCOPE_LABELS = { day: 'Today', week: 'This week', month: 'This month', groups: 'Groups', all: 'All time' };
    // The startup scope is the shortest span with at least this many cards.
    const MIN_STARTUP_CARDS = 5;
    // Pulling back past this multiple of the fitted distance widens the span one step.
    const SCOPE_PULL_BACK = 1.8;
    const scopeLabel = document.getElementById('scope-label');
    const scopeNarrow = document.getElementById('scope-narrow');
    const scopeWiden = document.getElementById('scope-widen');
    const renderScope = () => {
      syncThumbWheel();
      const index = SCOPES.indexOf(filterState.horizon);
      scopeLabel.textContent = (SCOPE_LABELS[filterState.horizon] || 'All time') + ' · ' + currentVisibleNodes.length;
      scopeNarrow.disabled = index <= 0;
      scopeWiden.disabled = index < 0 || index >= SCOPES.length - 1;
    };
    // Level of detail per scope (lod.js): short spans always show cards, Groups always shows proxies, All time follows
    // how large each cluster appears.
    // The 2D board always shows every card.
    const getLodMode = () => filterState.flat ? 'cards' : filterState.horizon === 'groups' ? 'groups' : filterState.horizon === 'all' ? 'auto' : 'cards';
    const pickStartupScope = nodes => SCOPES.filter(horizon => horizon !== 'groups')
      .find(horizon => horizon === 'all' || nodes.filter(node => isWithinHorizon(node, horizon)).length >= MIN_STARTUP_CARDS);
    // Changing the span leaves any gallery or open card and reframes what is now shown, again once the new cards settle.
    const setScope = horizon => {
      if (!SCOPES.includes(horizon) || horizon === filterState.horizon) return;
      filterState.horizon = horizon;
      timeFilter.value = horizon;
      if (gallery) closeClusterDrawer();
      if (focus.node) hideNodeCard();
      applyGraphFilters();
      if (filterState.view !== 'graph') return;
      cancelPendingFit();
      resetCameraView();
      scheduleFit();
    };
    const stepScope = delta => setScope(SCOPES[SCOPES.indexOf(filterState.horizon) + delta]);
    scopeNarrow.addEventListener('click', () => stepScope(-1));
    scopeWiden.addEventListener('click', () => stepScope(1));
    let scopeZoomTimer = null;
    const checkScopeZoom = () => {
      if (filterState.view !== 'graph' || filterState.flat || gallery || focus.node || (cameraRig && cameraRig.active) || zoomStop !== 'space') return;
      const index = SCOPES.indexOf(filterState.horizon);
      if (index < 0 || index >= SCOPES.length - 1) return;
      const distance = Graph.camera().position.distanceTo(Graph.controls().target);
      if (distance > getMacroFraming().distance * SCOPE_PULL_BACK) stepScope(1);
    };
    graphControls.addEventListener('end', () => {
      clearTimeout(scopeZoomTimer);
      scopeZoomTimer = setTimeout(() => {
        checkStopZoom();
        checkScopeZoom();
      }, 250);
    });

    // Closing the card steps back out from Node to the node's cluster (Group state).
    const closeNodeCard = () => {
      const node = focus.node;
      const wasFocused = Boolean(cameraRig && cameraRig.state === 'node');
      hideNodeCard();
      if (node && wasFocused && filterState.view === 'graph') flyToCluster(getClusterKey(node));
    };

    // The newest placed card of a cluster (a wall centres on it), or of everything shown.
    const isPlaced = node => [node.x, node.y, node.z].every(Number.isFinite);
    const newestIn = key => getClusterNodes(key).find(isPlaced) || null;
    const newestShown = () => Graph.graphData().nodes.filter(isPlaced)
      .reduce((best, node) => (!best || String(node.created_at || '') > String(best.created_at || '') ? node : best), null);
    // A card's wall: an Outcome opens its own, anything else its cluster's.
    const wallKeyOf = node => getNodeCategory(node) === 'outcome' ? 'outcome:' + node.id : getClusterKey(node);
    // The cluster nearest the middle of the view (smallest angle off the line of sight), or null.
    const clusterAhead = () => {
      const camera = Graph.camera().position;
      const target = Graph.controls().target;
      const look = { x: target.x - camera.x, y: target.y - camera.y, z: target.z - camera.z };
      const length = Math.hypot(look.x, look.y, look.z) || 1;
      let best = null;
      territories.entries.forEach((entry, key) => {
        if (!entry.center || !newestIn(key)) return;
        const to = { x: entry.center.x - camera.x, y: entry.center.y - camera.y, z: entry.center.z - camera.z };
        const cos = (look.x * to.x + look.y * to.y + look.z * to.z) / (length * (Math.hypot(to.x, to.y, to.z) || 1));
        if (!best || cos > best.cos) best = { key, cos };
      });
      return best ? best.key : null;
    };
    // Which cluster the stops act on: the open wall's, the open card's, the one ahead from Space, else the one framed
    // last, else the newest card's.
    const zoomContextKey = () => {
      if (gallery) return gallery.key;
      if (focus.node) return wallKeyOf(focus.node);
      const ahead = zoomStop === 'space' ? clusterAhead() : null;
      if (ahead) return ahead;
      if (clusterFrame && newestIn(clusterFrame.key)) return clusterFrame.key;
      const newest = newestShown();
      return newest ? wallKeyOf(newest) : null;
    };
    const setZoomStop = stop => {
      if (!ZOOM_STOP_ORDER.includes(stop) || filterState.view !== 'graph' || filterState.flat || xrPresenting()) return;
      cancelPendingFit();
      if (stop === 'space') {
        if (focus.node) hideNodeCard();
        closeClusterDrawer();
        resetCameraView();
        return;
      }
      const key = zoomContextKey();
      if (!key) return;
      if (stop === 'cluster') {
        if (focus.node) hideNodeCard();
        // Leaving the wall flies to its cluster (exitGallery); an Outcome's own wall has no island, so it goes to Space.
        if (gallery) closeClusterDrawer();
        else if (key.indexOf('outcome:') === 0) resetCameraView();
        else flyToCluster(key);
        return;
      }
      if (stop === 'horizon') {
        if (gallery) {
          if (focus.node) hideNodeCard();
          flyToArc();
          return;
        }
        const centre = focus.node && wallKeyOf(focus.node) === key ? focus.node : newestIn(key);
        if (focus.node) hideNodeCard();
        openClusterDrawer(key, { centerId: centre ? centre.id : null });
        return;
      }
      if (focus.node) return;
      const node = gallery ? aheadGalleryNode() : newestIn(key);
      if (node) focusCard(node);
    };
    const stepZoomStop = delta => {
      const index = ZOOM_STOP_ORDER.indexOf(zoomStop) + Math.sign(delta);
      if (index >= 0 && index < ZOOM_STOP_ORDER.length) setZoomStop(ZOOM_STOP_ORDER[index]);
    };
    // Dragging the slider shows the stop under the thumb; letting go (or a key press) goes there.
    zoomSlider.addEventListener('input', () => {
      const stop = ZOOM_STOP_ORDER[Number(zoomSlider.value)];
      zoomStopLabels.forEach(label => label.classList.toggle('active', label.dataset.stop === stop));
    });
    zoomSlider.addEventListener('change', () => {
      const stop = ZOOM_STOP_ORDER[Number(zoomSlider.value)];
      setZoomStop(stop);
      // A stop that could not be reached (nothing to show) leaves the slider where the view is.
      renderZoomStop();
    });
    zoomStopLabels.forEach(label => label.addEventListener('click', () => {
      setZoomStop(label.dataset.stop);
      renderZoomStop();
    }));
    // Free zoom in Space and Cluster: pushing in or pulling back well past the stop's framing moves one stop.
    const checkStopZoom = () => {
      if (filterState.view !== 'graph' || filterState.flat || gallery || focus.node || (cameraRig && cameraRig.active) || xrPresenting()) return;
      const distance = Graph.camera().position.distanceTo(Graph.controls().target);
      if (zoomStop === 'cluster' && clusterFrame) {
        if (distance < clusterFrame.distance * STOP_PUSH_IN) setZoomStop('horizon');
        else if (distance > clusterFrame.distance * STOP_PULL_BACK) setZoomStop('space');
      } else if (zoomStop === 'space' && distance < getMacroFraming().distance * STOP_PUSH_IN) {
        setZoomStop('cluster');
      }
    };
    // On the wall (stops 3 and 4) the orbit zoom is off, so the wheel steps between stops instead: one step per flick.
    // The whole flick is kept from the orbit controls and the flight canceller (window capture runs before both), also
    // after it has stepped out of the wall, or its tail would stop the flight out and zoom the camera back in.
    const WHEEL_GESTURE_MS = 250;
    let wheelStepper = null;
    let wheelGestureUntil = 0;
    // A trackpad's two-finger sideways swipe on the view steps cards on the wall (Horizon, Atomic), one per flick like
    // the stops.
    let cardWheelStepper = null;
    let cardWheelUntil = 0;
    window.addEventListener('wheel', event => {
      if (xrPresenting() || !window.AetherSpatial || !graphElement.contains(event.target)) return;
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (gallery && GROUP_SWIPE_STOPS.includes(zoomStop) && !filterState.flat && (sideways || performance.now() < cardWheelUntil) && event.deltaX) {
        event.stopPropagation();
        cardWheelUntil = performance.now() + WHEEL_GESTURE_MS;
        if (!cardWheelStepper) cardWheelStepper = window.AetherSpatial.createWheelStepper({ threshold: 90, idleMs: WHEEL_GESTURE_MS });
        const step = cardWheelStepper(event.deltaX, performance.now());
        if (step) swipeCard(step);
        return;
      }
      if (canStepCategories() && (sideways || performance.now() < cardWheelUntil) && event.deltaX) {
        event.stopPropagation();
        cardWheelUntil = performance.now() + WHEEL_GESTURE_MS;
        if (!cardWheelStepper) cardWheelStepper = window.AetherSpatial.createWheelStepper({ threshold: 90, idleMs: WHEEL_GESTURE_MS });
        const step = cardWheelStepper(event.deltaX, performance.now());
        if (step) stepCategory(step);
        return;
      }
      const now = performance.now();
      if (!gallery && now > wheelGestureUntil) return;
      event.stopPropagation();
      wheelGestureUntil = now + WHEEL_GESTURE_MS;
      if (!wheelStepper) wheelStepper = window.AetherSpatial.createWheelStepper({ idleMs: WHEEL_GESTURE_MS });
      const step = wheelStepper(event.deltaY, now);
      if (step) stepZoomStop(-step);
    }, { capture: true, passive: true });

    // Launch (zoom stops): once the first layout has spread, open the newest card's cluster as its wall (stop 3) instead
    // of the distant whole-graph view. The cards load a moment after the graph, so it waits for them, up to
    // LAUNCH_WAIT_MS, and falls back to the whole-graph view. Touching the canvas meanwhile cancels it (cancelPendingFit).
    const LAUNCH_WAIT_MS = 6000;
    const LAUNCH_RETRY_MS = 300;
    const scheduleLaunch = delay => {
      cancelPendingFit();
      const started = Date.now() + delay;
      const attempt = () => {
        fitTimer = null;
        if (filterState.view !== 'graph' || focus.node || gallery) return;
        const home = newestShown();
        const ready = home && cardField && !filterState.flat && cardField.has(home.id);
        if (ready) {
          openClusterDrawer(wallKeyOf(home), { centerId: home.id });
          if (gallery) return;
        } else if (Date.now() - started < LAUNCH_WAIT_MS) {
          fitTimer = setTimeout(attempt, LAUNCH_RETRY_MS);
          return;
        }
        resetCameraView();
      };
      fitTimer = setTimeout(attempt, delay);
    };

    // Home / recentre (2026-10-01): sets the current view straight again without leaving it (it used to go back to the
    // launch view in 3D from anywhere). List, Timeline, Board and Carousel scroll back to the top-left; the 2D board
    // drops its pan and zoom. In 3D the camera re-frames the current stop: Space looks at the scene origin (0, 0, 0)
    // from the default angle and distance, Cluster re-frames the framed group, Horizon turns back to the middle of the
    // wall, and Atomic re-frames the open card.
    const resetCollectionScroll = () => {
      // Scrolled panes inside the view too (the Board's columns, a sideways Timeline).
      [collectionView, ...collectionView.querySelectorAll('*')].forEach(element => {
        if (element.scrollTop || element.scrollLeft) element.scrollTo({ top: 0, left: 0 });
      });
    };
    const recentreView = () => {
      if (xrPresenting()) return;
      if (filterState.view !== 'graph') {
        resetCollectionScroll();
        return;
      }
      cancelPendingFit();
      if (filterState.flat) {
        resetCameraView();
      } else if (focus.node) {
        flyToNode(focus.node);
      } else if (gallery) {
        gallery.look = gallery.homeLook || gallery.look;
        flyToArc();
      } else if (zoomStop === 'cluster' && clusterFrame) {
        flyToCluster(clusterFrame.key);
      } else {
        clusterFrame = null;
        cameraGoTo({ target: { x: 0, y: 0, z: 0 }, distance: getMacroFraming().distance, theta: 0, phi: Math.PI / 2, state: 'macro' });
      }
    };
    document.getElementById('wheel-home').addEventListener('click', event => {
      event.stopPropagation();
      recentreView();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Home' && event.key !== 'h' && event.key !== 'H') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (document.querySelector('.modal-backdrop:not([hidden])') || !loginGate.hidden) return;
      event.preventDefault();
      recentreView();
    });
    // Free zoom (Space and Cluster) goes toward what the pointer is on, not the orbit's pivot, so scrolling at a card
    // brings it nearer instead of flying past it or away.
    graphControls.zoomToCursor = true;

    // A filter change reframes what is left once it has had a moment to settle (typing debounces through scheduleFit).
    const reframeAfterFilter = () => {
      if (filterState.view === 'graph' && !focus.node) scheduleFit(400);
    };

    import('/vendor/three-0.180.0/three.module.js')
      .then(module => {
        THREE = module;
        if (viewer) viewer.attachDolly(THREE, Graph.scene());
        setupXR();
        territories.group = new THREE.Group();
        Graph.scene().add(territories.group);
        refreshGraphStyles();
        syncTerritories(territories.visibleNodes);
        initCards();
      })
      .catch(err => console.error('three.js failed to load; keeping default node spheres', err));

    // Short, stiff links inside a category and long, loose ones across categories keep islands apart.
    // Repulsion is strong for small graphs (-120) and eases off for big ones so a thousand nodes don't explode.
    const getChargeStrength = count => -Math.max(40, Math.min(120, 1200 / Math.sqrt(Math.max(count, 1))));
    Graph.d3Force('charge').strength(getChargeStrength(0)).distanceMax(260);
    Graph.d3Force('link')
      .distance(link => isSameClusterLink(link) ? 22 : 110)
      .strength(link => isSameClusterLink(link) ? 0.5 : 0.03);
    Graph.d3Force('cluster', clusterForce());

    // Pill labels carry counts of the nodes the other filters leave visible, e.g. "YouTube (4)".
    const platformBar = document.getElementById('platform-bar');
    const filterBadge = document.getElementById('filter-badge');
    const PLATFORM_LABELS = { all: 'All', youtube: 'YouTube', x: 'X/Twitter', facebook: 'Facebook', links: 'Links', notes: 'Notes', images: 'Images' };
    const renderPlatformBar = visibleNodes => {
      syncThumbWheel();
      const counts = { all: visibleNodes.length };
      visibleNodes.forEach(node => {
        const platform = getPlatform(node);
        counts[platform] = (counts[platform] || 0) + 1;
      });
      platformBar.querySelectorAll('[data-platform]').forEach(pill => {
        const key = pill.dataset.platform;
        const active = filterState.platform === key;
        pill.textContent = PLATFORM_LABELS[key] + ' (' + (counts[key] || 0) + ')';
        pill.setAttribute('aria-pressed', String(active));
        pill.disabled = !active && key !== 'all' && !counts[key];
      });
    };

    // Recolors in place (no layout restart); list and timeline re-render to show only the matching platform.
    // Clicking the active pill again goes back to All.
    const setPlatform = platform => {
      filterState.platform = PLATFORM_LABELS[platform] && platform !== filterState.platform ? platform : 'all';
      refreshGraphStyles();
      renderPlatformBar(currentVisibleNodes);
      if (filterState.view !== 'graph') renderCollection();
    };
    platformBar.addEventListener('click', event => {
      const pill = event.target.closest('[data-platform]');
      if (pill && !pill.disabled) setPlatform(pill.dataset.platform);
    });

    const toggleHighlight = category => {
      if (filterState.highlighted.has(category)) filterState.highlighted.delete(category);
      else filterState.highlighted.add(category);
      applyGraphFilters();
      // Two or more highlighted: the ◀ ▶ arrows step between them.
      startGalleryNav();
    };
    // The legend's order: the fixed category order, then anything else alphabetically.
    const legendRank = category => {
      const index = CATEGORY_ORDER.indexOf(category);
      return index >= 0 ? index : CATEGORY_ORDER.length;
    };

    const renderLegend = visibleNodes => {
      const counts = new Map();
      visibleNodes.forEach(node => {
        const category = getNodeCategory(node);
        counts.set(category, (counts.get(category) || 0) + 1);
      });
      // Keep highlighted categories listed (at 0) so they can still be toggled off.
      filterState.highlighted.forEach(category => { if (!counts.has(category)) counts.set(category, 0); });

      const categories = [...counts.keys()].sort((a, b) => legendRank(a) - legendRank(b) || a.localeCompare(b));

      legendItems.replaceChildren(...categories.map(category => {
        const item = document.createElement('button');
        item.className = 'legend-item';
        item.classList.toggle('active', filterState.highlighted.has(category));
        item.classList.toggle('dimmed', filterState.highlighted.size > 0 && !filterState.highlighted.has(category));

        const badge = document.createElement('span');
        badge.className = 'legend-badge';
        badge.style.background = getCategoryColor(category);
        const name = document.createElement('span');
        name.className = 'legend-name';
        name.textContent = category.replace(/_/g, ' ');
        const count = document.createElement('span');
        count.className = 'legend-count';
        count.textContent = String(counts.get(category));

        item.append(badge, name, count);
        // Highlighting a category also glides the camera to its cluster centre (a pending auto-fit would pull
        // it back); un-highlighting leaves the camera where it is.
        item.addEventListener('click', () => {
          const highlighting = !filterState.highlighted.has(category);
          toggleHighlight(category);
          // The last highlight off: its cluster stops being the orbit's pivot.
          if (!highlighting && !filterState.highlighted.size && clusterFrame && !gallery && !focus.node) recentreOrbit();
          if (!highlighting || filterState.view !== 'graph') return;
          cancelPendingFit();
          // An open card or wall would hold the camera; the category's flight takes over from them.
          if (focus.node) hideNodeCard();
          if (gallery) closeClusterDrawer({ fly: false });
          if (gallery) exitGallery({ fly: false });
          flyToCategory(category);
        });
        return item;
      }));
      legend.style.visibility = categories.length ? 'visible' : 'hidden';
      const legendActive = document.getElementById('legend-active');
      legendActive.hidden = !filterState.highlighted.size;
      legendActive.textContent = String(filterState.highlighted.size);
    };

    // ---- Connection Depth slider (PROJECT_STATE.md step 2). Moving it re-filters the wires at once (3D, gallery and the
    // board's Map); the level is saved shortly after, for the nightly synthesis. ----
    const DEPTH_LEVELS = ['obvious', 'logical', 'abstract'];
    const DEPTH_LABELS = { obvious: 'Obvious', logical: 'Logical', abstract: 'Abstract' };
    const DEPTH_SAVE_DELAY_MS = 500;
    const depthSlider = document.getElementById('depth-slider');
    const depthStops = [...document.querySelectorAll('.depth-stops [data-depth]')];
    // The top bar has no room for it on phones, so there it sits in the filter row, after the time span.
    const depthControl = document.getElementById('depth-control');
    const phoneBar = window.matchMedia('(max-width: 600px)');
    const placeDepthControl = () => {
      if (phoneBar.matches) document.getElementById('scope-stepper').after(depthControl);
      else document.getElementById('view-toggle').before(depthControl);
    };
    placeDepthControl();
    phoneBar.addEventListener('change', placeDepthControl);
    const renderDepth = () => {
      syncThumbWheel();
      depthSlider.value = String(DEPTH_LEVELS.indexOf(filterState.depth));
      depthSlider.setAttribute('aria-valuetext', DEPTH_LABELS[filterState.depth]);
      depthStops.forEach(stop => stop.classList.toggle('active', stop.dataset.depth === filterState.depth));
    };
    renderDepth();
    const linksAtDepth = links => {
      const spatial = window.AetherSpatial;
      if (!spatial) return links;
      const byId = new Map(graphData.nodes.map(node => [String(node.id), node]));
      return spatial.visibleLinks(links, filterState.depth, id => spatial.primaryGroup(byId.get(id)));
    };
    let depthSaveTimer = null;
    const saveDepth = () => {
      clearTimeout(depthSaveTimer);
      depthSaveTimer = setTimeout(async () => {
        try {
          await apiFetch('/api/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection_depth: filterState.depth })
          });
        } catch (err) {
          console.error('Saving the connection depth failed:', err);
        }
      }, DEPTH_SAVE_DELAY_MS);
    };
    const setDepth = level => {
      if (!DEPTH_LEVELS.includes(level) || level === filterState.depth) return;
      filterState.depth = level;
      renderDepth();
      applyGraphFilters();
      saveDepth();
    };
    depthSlider.addEventListener('input', () => setDepth(DEPTH_LEVELS[Number(depthSlider.value)] || 'logical'));

    const applyGraphFilters = () => {
      // Proposed Outcome Nodes always show, whatever the time scope, so a fresh synthesis is never missed.
      const isFreshOutcome = node => getNodeCategory(node) === 'outcome' && node.outcome_status === 'proposed';
      let filteredNodes = graphData.nodes.filter(node => matchesTypeFilter(node) && (matchesTimeFilter(node) || isFreshOutcome(node)) && matchesSearch(node));
      let visibleIds = new Set(filteredNodes.map(node => node.id));
      const inScopeLinks = graphData.links.filter(link => visibleIds.has(linkEndId(link.source)) && visibleIds.has(linkEndId(link.target)));
      // Connection Depth decides which wires cross groups (public/js/spatial/depth.js).
      const filteredLinks = linksAtDepth(inScopeLinks);

      // Orphans are judged against what survives the other filters, so a node whose only neighbours were filtered out hides too.
      const orphanButton = document.getElementById('orphan-toggle');
      if (filterState.hideOrphans) {
        const linkedIds = new Set();
        filteredLinks.forEach(link => {
          const sourceId = linkEndId(link.source);
          const targetId = linkEndId(link.target);
          if (sourceId === targetId) return;
          linkedIds.add(sourceId);
          linkedIds.add(targetId);
        });
        const before = filteredNodes.length;
        filteredNodes = filteredNodes.filter(node => linkedIds.has(node.id));
        visibleIds = new Set(filteredNodes.map(node => node.id));
        orphanButton.textContent = 'Hide Unlinked · ' + (before - filteredNodes.length);
      } else {
        orphanButton.textContent = 'Hide Unlinked';
      }
      // Self-loops on a hidden orphan would otherwise point at a missing node.
      const shownLinks = filterState.hideOrphans ? filteredLinks.filter(link => visibleIds.has(linkEndId(link.source))) : filteredLinks;

      if (hover.id && !visibleIds.has(hover.id)) setHover(null);
      Graph.d3Force('charge').strength(getChargeStrength(filteredNodes.length));
      updateClusters(filteredNodes);
      updateClusterSpacing(filteredNodes);
      updateHubWeights(filteredNodes, shownLinks);
      Graph.graphData({ nodes: filteredNodes, links: shownLinks });
      // The engine's 15 s cooldown runs even while the canvas is hidden, so a layout started behind
      // List/Timeline/Board can stop before it ever ran; returning to the graph restarts it.
      if (filterState.view !== 'graph') layoutDirty = true;
      // A focused node that got filtered out drops the focus along with its card.
      if (focus.node && !visibleIds.has(focus.node.id)) hideNodeCard();
      else if (focus.node) {
        setFocus(focus.node);
        buildCarousel(focus.node);
        renderCarousel(focus.node);
      }
      else refreshGraphStyles();
      renderLegend(filteredNodes);
      renderPlatformBar(filteredNodes);
      const activeFilters = (filterState.horizon !== 'all') + (filterState.type !== 'all') + filterState.hideOrphans;
      filterBadge.textContent = String(activeFilters);
      filterBadge.hidden = !activeFilters;
      syncTerritories(filteredNodes);
      renderClusterDrawer();
      currentVisibleNodes = filteredNodes;
      renderScope();
      if (cardField) cardField.setLodMode(getLodMode());
      if (cardField) cardField.retain(visibleIds);
      refreshGallery();
      layoutBoard();
      renderActiveView();
    };

    const loadGraph = async () => {
      const res = await fetch('/api/graph');
      if (res.status === 401) {
        showLoginGate();
        return;
      }
      if (!res.ok) throw new Error('Graph request failed: ' + res.status);
      const previous = new Map(graphData.nodes.map(node => [node.id, node]));
      const payload = await res.json();
      graphData = normalizeGraphData(payload);
      if (payload && DEPTH_LEVELS.includes(payload.connection_depth)) {
        filterState.depth = payload.connection_depth;
        renderDepth();
      }
      renderUserGreeting(payload ? payload.preferred_name : null);
      const firstLoad = !graphLoaded;
      if (!firstLoad) keepLayout(previous, graphData.nodes);
      // First load opens on a short, recent time span (the shortest with enough cards) instead of everything; a deep
      // link keeps whatever span shows its card.
      if (!graphLoaded && !deepLinkId) {
        filterState.horizon = pickStartupScope(graphData.nodes);
        timeFilter.value = filterState.horizon;
      }
      graphLoaded = true;
      pinToPlane(graphData.nodes);
      applyGraphFilters();
      // First load in graph view: the layout grows out from the origin, so frame it once it has spread. A reload keeps
      // the layout (keepLayout), so it leaves the camera where it is.
      if (firstLoad && filterState.view === 'graph' && !deepLinkId) scheduleLaunch(FIT_SETTLE_MS + 600);
      else if (firstLoad && filterState.view === 'graph') scheduleFit(FIT_SETTLE_MS + 600);
      if (deepLinkId) openDeepLink();
      openLiveSync();
    };

    // ---- Live sync (src/graph-events.js): changes made in another tab or device (or by the Telegram bot) arrive on
    // /api/events, and this tab reloads the graph in place (keepLayout holds positions and the camera). The stream is
    // closed while the tab is hidden and reopened, with one catch-up reload, when it shows again. ----
    const LIVE_RELOAD_DELAY_MS = 400;
    const LIVE_EVENT_TYPES = ['node.created', 'node.updated', 'node.deleted', 'link.created', 'link.updated', 'link.deleted', 'group.updated', 'settings.updated', 'graph.changed'];
    let liveEvents = null;
    let liveReloadTimer = null;
    const scheduleLiveReload = () => {
      clearTimeout(liveReloadTimer);
      liveReloadTimer = setTimeout(() => {
        loadGraph().catch(err => console.warn('Live sync reload failed:', err));
      }, LIVE_RELOAD_DELAY_MS);
    };
    const onLiveEvent = message => {
      let event = null;
      try {
        event = JSON.parse(message.data);
      } catch (err) {
        return;
      }
      if (!event || event.origin === LIVE_CLIENT_ID) return;
      scheduleLiveReload();
      // For any view that wants to react to a particular change.
      window.dispatchEvent(new CustomEvent('aether-graph-event', { detail: event }));
    };
    function openLiveSync() {
      if (liveEvents || typeof EventSource !== 'function' || document.visibilityState === 'hidden' || !graphLoaded) return;
      liveEvents = new EventSource('/api/events');
      LIVE_EVENT_TYPES.forEach(type => liveEvents.addEventListener(type, onLiveEvent));
      // A refused stream (signed out, or live sync not configured) closes for good; a dropped one retries by itself.
      liveEvents.addEventListener('error', () => {
        if (liveEvents && liveEvents.readyState === 2) liveEvents = null;
      });
    }
    const closeLiveSync = () => {
      if (!liveEvents) return;
      liveEvents.close();
      liveEvents = null;
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        closeLiveSync();
        return;
      }
      if (!graphLoaded || liveEvents) return;
      openLiveSync();
      scheduleLiveReload();
    });

    // A reload (after an admin run, for example) would otherwise rebuild every node without a position and regrow the
    // whole layout from the origin, so anything focused right after it would slide away. Known nodes keep their
    // positions; a new Outcome starts between the saves it cites, and any other new node next to the camera target.
    const keepLayout = (previous, nodes) => {
      const byId = new Map();
      nodes.forEach(node => {
        const old = previous.get(node.id);
        if (old && [old.x, old.y, old.z].every(Number.isFinite)) {
          ['x', 'y', 'z', 'vx', 'vy', 'vz'].forEach(axis => { node[axis] = old[axis]; });
        }
        byId.set(node.id, node);
      });
      nodes.forEach(node => {
        if ([node.x, node.y, node.z].every(Number.isFinite)) return;
        const inputs = (node.outcome_inputs || []).map(id => byId.get(id)).filter(item => item && Number.isFinite(item.x));
        const centre = inputs.length
          ? inputs.reduce((sum, item) => ({ x: sum.x + item.x / inputs.length, y: sum.y + item.y / inputs.length, z: sum.z + item.z / inputs.length }), { x: 0, y: 0, z: 0 })
          : null;
        seedNodePosition(node, centre);
      });
    };

    // A /node/<id> deep link (the share sheet's View Node button) opens that node's card on the first load.
    let deepLinkId = (() => {
      const match = /^[/]node[/]([^/]+)[/]?$/.exec(window.location.pathname);
      if (!match) return '';
      try {
        return decodeURIComponent(match[1]).trim();
      } catch (err) {
        return '';
      }
    })();
    const openDeepLink = () => {
      const id = deepLinkId;
      deepLinkId = '';
      if (!graphData.nodes.some(node => String(node.id) === id)) return;
      const findShown = () => Graph.graphData().nodes.find(node => String(node.id) === id);
      // A filter left over from last time may hide it; clear the filters rather than open nothing.
      if (!findShown()) resetFilters();
      const node = findShown();
      if (!node) return;
      selectNode(node);
      // The layout has no positions yet on first load; once it has spread, open the node's group gallery around it
      // (if the card is still open).
      setTimeout(() => {
        if (focus.node === node) focusNewNode(node.id);
      }, FIT_SETTLE_MS);
    };

    // fz is honored by the d3 simulation; null releases the node back into 3D.
    // The 2D board (Phase 5) shows cards at board slots and never moves the force layout, so nothing is pinned.
    const pinToPlane = nodes => {
      nodes.forEach(node => { node.fz = null; });
    };

    // ---- WebXR (SPATIAL_ARCHITECTURE.md 5, Phase 6). In a headset the portal opens as mixed reality where the device
    // has passthrough (immersive-ar), else VR. The whole graph floats in front of the user; pointing at a card and
    // selecting it (trigger or pinch) opens its 180-degree gallery around the user, who is moved to its centre behind a
    // short fade; squeeze, B/Y or selecting empty space goes back to the whole graph. The thumbstick snap-turns 30
    // degrees. The graph library's own animation loop is paused and one cycle of it (layout tick and render) runs per
    // XR frame. ----
    const xrButton = document.getElementById('xr-button');
    let xr = null;
    let xrMode = null;
    let xrVrSupported = false;
    let xrSaved = null;
    let xrRaycaster = null;
    const xrHovered = new Map();
    const xrPresenting = () => Boolean(xr && xr.isActive());
    // Headset rays always come from the pointing pose now; an older build remembered a grip-ray choice here, which kept
    // the Quest on a ray pointing at the sky. Clear it.
    try { localStorage.removeItem('aetherXrRayMode'); } catch (err) {}
    // A gallery's arc radius in a headset (graph units; 18 on screens) and the size cards are drawn at in the overview:
    // about XR_OVERVIEW_CARD_M wide, at most XR_OVERVIEW_CARD_MAX times their graph size.
    const XR_GALLERY_MIN_RADIUS = 36;
    // How far a focused card slides toward the viewer in a headset, as a share of the arc's radius.
    const XR_FOCUS_SLIDE = 0.1;
    const XR_OVERVIEW_CARD_M = 0.15;
    const XR_OVERVIEW_CARD_MAX = 6;

    const xrPick = ray => {
      if (!xrRaycaster) xrRaycaster = new THREE.Raycaster();
      xrRaycaster.set(ray.origin, ray.direction);
      xrRaycaster.camera = Graph.camera();
      // The lens barrel's rings, hub and keys take the ray first: they ride on the wrist, in front of the cards.
      if (xrBarrel) {
        const part = xrBarrel.pick(xrRaycaster);
        if (part) return { distance: part.distance, barrel: part };
      }
      const roots = Graph.graphData().nodes.map(node => node.__threeObj).filter(Boolean);
      const hit = xrRaycaster.intersectObjects(roots, true)[0];
      if (!hit) return null;
      let object = hit.object;
      while (object && !object.__data) object = object.parent;
      return object ? { distance: hit.distance, node: object.__data } : null;
    };
    const xrBarrelHover = new Map();
    const xrOnHover = (hand, hit) => {
      if (hit && hit.barrel) {
        // A light buzz when the ray moves onto another ring, key or the hub.
        const before = xrBarrelHover.get(hand);
        if (!before || before.kind !== hit.barrel.kind || before.id !== hit.barrel.id) xr.pulse(hand, 0.15, 15);
        xrBarrelHover.set(hand, hit.barrel);
      } else {
        xrBarrelHover.delete(hand);
      }
      if (xrBarrel) xrBarrel.setHover(xrBarrelHover.get(1) || xrBarrelHover.get(0) || null);
      if (hit && hit.node) xrHovered.set(hand, hit.node);
      else xrHovered.delete(hand);
      const node = xrHovered.get(1) || xrHovered.get(0) || null;
      if (node) {
        if (hover.id !== node.id) setHover(node, 'xr');
      } else if (hover.source === 'xr') {
        setHover(null);
      }
    };
    const xrPlaceOverview = (instant = false) => {
      const bbox = Graph.getGraphBbox();
      if (!bbox) return;
      const center = { x: (bbox.x[0] + bbox.x[1]) / 2, y: (bbox.y[0] + bbox.y[1]) / 2, z: (bbox.z[0] + bbox.z[1]) / 2 };
      const radius = Math.max(30, Math.hypot(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], bbox.z[1] - bbox.z[0]) / 2);
      xrPlacementKind = 'overview';
      xr.place(head => {
        const next = window.AetherSpatial.overviewPlacement({ center, radius, head });
        const cardMetres = window.AetherSpatial.CARD_WIDTH / next.scale;
        if (cardField) {
          cardField.setGlobalScale(Math.min(XR_OVERVIEW_CARD_MAX, Math.max(1, XR_OVERVIEW_CARD_M / cardMetres)));
          cardField.setUnitsPerMetre(next.scale);
        }
        return next;
      }, { instant });
    };
    const xrPlaceGallery = () => {
      if (!gallery) return;
      const { origin, yaw, radius } = gallery;
      xrPlacementKind = 'gallery';
      xr.place(head => {
        const next = window.AetherSpatial.galleryPlacement({ origin, yaw, radius, head });
        if (cardField) {
          cardField.setGlobalScale(1);
          cardField.setUnitsPerMetre(next.scale);
        }
        return next;
      });
    };
    const xrOnSelect = (ray, hand) => {
      const hit = xrPick(ray);
      // Rings are turned by holding them (xrOnGrab); a click on the hub or a key acts.
      if (hit && hit.barrel) {
        if (hit.barrel.kind !== 'ring') {
          xr.pulse(hand, 0.5, 30);
          xrAction(hit.barrel.id);
        }
        return;
      }
      if (!hit) {
        xrOnBack();
        return;
      }
      const before = gallery ? gallery.key : null;
      focusCard(hit.node);
      // The focused card comes only a little way forward: it is already at a comfortable size on the headset's arc.
      if (gallery) cardField.setGallerySlide(gallery.radius * XR_FOCUS_SLIDE);
      // A new gallery: stand at its centre. A card on the wall already around the user just slides forward.
      if (gallery && gallery.key !== before) xrPlaceGallery();
    };
    const xrOnBack = () => {
      if (!gallery && !focus.node) return;
      resetSelection();
      if (filterState.flat) xrPlaceBoard();
      else xrPlaceOverview();
    };
    const xrFrame = time => {
      if (cardField) cardStep(time);
      if (xrBarrel) {
        xrBarrel.sync();
        xrBarrel.frame(xr.gripFor('left'), time);
      }
      syncXrBoardLabels();
      // One cycle of the graph (layout tick, controls, render); the cycle schedules its own animation frame, which is
      // cancelled straight away so only the XR loop renders. Its render goes straight to the headset (xrDirectRender).
      Graph._animationCycle();
      Graph.pauseAnimation();
    };
    // The graph library renders every frame through its post-processing composer, whose last pass draws to the page's
    // own canvas. In a headset that bypasses the XR layer: the room stays empty and a side-by-side stereo image lands
    // on the 2D canvas (seen behind the system menu). While presenting, the composer renders the scene directly, which
    // three.js sends to the XR layer; the original render comes back on exit.
    const xrDirectRender = on => {
      const composer = Graph.postProcessingComposer();
      if (!composer) return;
      if (on && !xrSaved.composerRender) {
        xrSaved.composerRender = composer.render;
        composer.render = () => Graph.renderer().render(Graph.scene(), Graph.camera());
      } else if (!on && xrSaved && xrSaved.composerRender) {
        composer.render = xrSaved.composerRender;
        xrSaved.composerRender = null;
      }
    };
    const xrOnEnd = () => {
      if (xrSaved) xrDirectRender(false);
      setDarkRoom(false);
      syncXrBoardLabels();
      viewer.setPresenting(false);
      if (cardField) {
        cardField.setGlobalScale(1);
        cardField.setUnitsPerMetre(null);
      }
      document.body.classList.remove('xr-presenting');
      if (xrSaved) Graph.backgroundColor(xrSaved.background);
      xrSaved = null;
      xrHovered.clear();
      if (hover.source === 'xr') setHover(null);
      Graph.controls().enabled = true;
      Graph.resumeAnimation();
      // The window may have changed size while the headset owned the view.
      scheduleGraphFit();
      resetSelection();
      resetCameraView();
    };
    // The dark space shown around the graph in VR (the page's own navy).
    const XR_VR_BACKGROUND = '#05080f';
    const enterXR = async (requested = xrMode) => {
      if (!xr || xrPresenting()) return;
      xrMenu.hidden = true;
      stopMedia();
      // XR starts from the 3D space with nothing open.
      if (filterState.flat) viewToggle.click();
      if (filterState.view !== 'graph') setView('graph');
      resetSelection();
      cancelPendingFit();
      if (cameraRig && cameraRig.active) {
        cameraRig.cancel();
        finishFlight();
      }
      xrSaved = { background: Graph.backgroundColor(), composerRender: null };
      viewer.setPresenting(true);
      document.body.classList.add('xr-presenting');
      const controls = Graph.controls();
      controls.autoRotate = false;
      controls.enabled = false;
      xrDirectRender(true);
      Graph.pauseAnimation();
      // The chosen mode; mixed reality falls back to VR when the headset cannot start it.
      const modes = requested === 'immersive-ar' && xrVrSupported ? ['immersive-ar', 'immersive-vr'] : [requested];
      let lastError = null;
      for (const mode of modes) {
        try {
          // Mixed reality shows the room through the headset: nothing is drawn behind the graph.
          Graph.backgroundColor(mode === 'immersive-ar' ? 'rgba(0,0,0,0)' : XR_VR_BACKGROUND);
          // The controls start pinned in front of the user at waist height, where they are seen straight away (on
          // the wrist they only show once the left hand is raised into view); Pin moves them to the wrist.
          if (xrBarrel) xrBarrel.setPinned(true);
          await xr.start(mode);
          xrPlaceOverview(true);
          return;
        } catch (err) {
          console.error('Entering ' + mode + ' failed:', err);
          lastError = err;
        }
      }
      xrOnEnd();
      alert('Could not start the headset view: ' + ((lastError && lastError.message) || lastError));
    };
    const setupXR = async () => {
      if (xr || !THREE || !window.AetherSpatial || !viewer || !viewer.getDolly()) return;
      const support = await window.AetherSpatial.xrSupport();
      xrMode = support.ar ? 'immersive-ar' : support.vr ? 'immersive-vr' : null;
      xrVrSupported = support.vr;
      if (!xrMode || xr) return;
      xr = window.AetherSpatial.createXR({
        THREE,
        renderer: Graph.renderer(),
        scene: Graph.scene(),
        camera: Graph.camera(),
        dolly: viewer.getDolly(),
        frame: xrFrame,
        pick: xrPick,
        onHover: xrOnHover,
        onSelect: xrOnSelect,
        onBack: xrOnBack,
        onEnd: xrOnEnd,
        onMenu: () => { if (xrBarrel) xrBarrel.toggle(); },
        onScale: xrOnScale,
        onGrab: xrOnGrab,
        onDrag: xrOnDrag,
        onRelease: hand => { if (xrBarrel) xrBarrel.release(hand); }
      });
      xrBarrel = window.AetherSpatial.createBarrel({
        THREE,
        dolly: viewer.getDolly(),
        camera: Graph.camera(),
        rings: xrBarrelRingDefs(),
        state: xrBarrelState,
        onChange: xrBarrelChange,
        onAction: xrAction,
        // One click per stop through the hand turning the ring (the right one when the ring turned by itself).
        onTick: (hand, end) => xr.pulse(hand === null || hand === undefined ? 1 : hand, end ? 0.6 : 0.3, end ? 24 : 12)
      });
      xrBothModes = support.ar && support.vr;
      xrButton.querySelector('.bar-label').textContent = xrBothModes ? 'Enter XR' : support.ar ? 'Enter MR' : 'Enter VR';
      xrButton.dataset.short = xrBothModes ? 'XR' : support.ar ? 'MR' : 'VR';
      xrButton.title = xrBothModes ? 'Step into your graph: mixed reality or VR' : support.ar ? 'Step into your graph in mixed reality' : 'Step into your graph in VR';
      xrButton.hidden = false;
    };
    // With both modes available the button offers a choice (mixed reality or VR); otherwise it enters the one there is.
    const xrMenu = document.getElementById('xr-menu');
    let xrBothModes = false;
    // ---- Inline video (video pipeline phase 1, on screens). YouTube and Vimeo play in their official embed players,
    // video files in a <video>; anything else launches in a new tab. The player is pinned over the playing card's face
    // in the graph (3D and the 2D board) and follows it every frame; with no card on screen (List, Timeline, Board,
    // Carousel views) it floats centred. One video plays at a time; it stops when its card loses focus or the view
    // changes. In a headset, web pages do not render, so play is not offered there (phase 3 covers XR). ----
    const mediaPlayer = document.getElementById('media-player');
    const mediaFrame = document.getElementById('media-frame');
    let playing = null;
    let mediaFrameLoop = 0;
    const isPlayableLink = url => Boolean(window.AetherSpatial && window.AetherSpatial.isPlayable(url));
    // Drawn icons rather than characters, which some systems render as colour emoji.
    const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>';
    const LAUNCH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // Turns a link element into the compact play or launch button.
    const styleLinkAction = (element, url, playable) => {
      element.innerHTML = playable ? PLAY_ICON : LAUNCH_ICON;
      element.classList.add('link-action');
      element.classList.toggle('play', playable);
      element.classList.toggle('launch', !playable);
      element.title = playable ? 'Play video' : 'Open in a new tab';
      element.setAttribute('aria-label', playable ? 'Play video' : 'Open in a new tab');
      element.dataset.play = playable ? '1' : '';
    };
    // A card list's link button: plays the node's video, or opens the link in a new tab.
    const buildLinkAction = node => {
      const link = document.createElement('a');
      link.href = node.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      styleLinkAction(link, node.url, isPlayableLink(node.url));
      link.addEventListener('click', event => {
        event.stopPropagation();
        if (!link.dataset.play) return;
        event.preventDefault();
        // On the wall (Horizon) with no card open, the view turns to the card and it plays there, without zooming in.
        if (filterState.view === 'graph' && gallery && !focus.node && gallery.ids.has(String(node.id))) {
          const look = lookAtSlot(node.id);
          if (look) {
            gallery.look = look;
            flyToArc();
          }
          playMedia(node, { wall: true });
          return;
        }
        selectNode(node, { fly: true });
        playMedia(node);
      });
      return link;
    };
    const stopMedia = () => {
      if (!playing) return;
      playing = null;
      if (playingCardId) {
        playingCardId = null;
        syncCards();
      }
      mediaFrame.replaceChildren();
      mediaPlayer.hidden = true;
      cancelAnimationFrame(mediaFrameLoop);
      mediaFrameLoop = 0;
    };
    // options.wall: started on the Horizon wall with no card open, so it plays pinned over the card where it stands.
    const playMedia = (node, options = {}) => {
      const media = window.AetherSpatial && window.AetherSpatial.parseMedia(node.url);
      if (!media || xrPresenting()) {
        window.open(node.url, '_blank', 'noopener');
        return;
      }
      stopMedia();
      let element;
      if (media.kind === 'file') {
        element = document.createElement('video');
        element.src = media.src;
        element.controls = true;
        element.autoplay = true;
        element.playsInline = true;
      } else {
        element = document.createElement('iframe');
        element.src = media.embedUrl;
        element.title = node.title || 'Video';
        element.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        element.allowFullscreen = true;
        // YouTube's embeds refuse to play without a referrer.
        element.referrerPolicy = 'strict-origin-when-cross-origin';
      }
      mediaFrame.replaceChildren(element);
      playing = { id: String(node.id), view: filterState.view, wall: Boolean(options.wall) };
      if (playing.wall) {
        playingCardId = playing.id;
        syncCards();
      }
      mediaPlayer.hidden = false;
      placeMedia();
    };
    document.getElementById('media-close').addEventListener('click', stopMedia);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && playing) stopMedia();
    });
    // Screen rectangle of a card's face, or null when it is not in front of the camera.
    const cardFaceRect = node => {
      const root = node && node.__threeObj;
      if (!root || !THREE || !root.visible) return null;
      const spatial = window.AetherSpatial;
      const canvas = Graph.renderer().domElement.getBoundingClientRect();
      const camera = Graph.camera();
      root.updateMatrixWorld(true);
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const corner = root.localToWorld(new THREE.Vector3(sx * spatial.CARD_WIDTH / 2, sy * spatial.CARD_HEIGHT / 2, 0)).project(camera);
        if (corner.z > 1 || corner.z < -1) return null;
        const x = canvas.left + (corner.x + 1) / 2 * canvas.width;
        const y = canvas.top + (1 - corner.y) / 2 * canvas.height;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      return { left, top, width: right - left, height: bottom - top };
    };
    // The smallest the pinned player gets, in pixels; a smaller card gets the centred player instead.
    const MEDIA_MIN_WIDTH = 240;
    const placeMedia = () => {
      mediaFrameLoop = 0;
      if (!playing) return;
      // The card it plays over: the open card, or (started on the Horizon wall) its card on the wall.
      const node = focus.node && String(focus.node.id) === playing.id ? focus.node
        : playing.wall && !focus.node && gallery && gallery.ids.has(playing.id)
          ? Graph.graphData().nodes.find(item => String(item.id) === playing.id) || null
          : null;
      // Stops with its card: another card focused, the card closed or off the wall, or the view changed.
      if (filterState.view !== playing.view || (playing.pinned && !node)) {
        stopMedia();
        return;
      }
      const rect = filterState.view === 'graph' && node ? cardFaceRect(node) : null;
      let box;
      const onCard = Boolean(rect && rect.width >= MEDIA_MIN_WIDTH);
      if (onCard) {
        playing.pinned = true;
        // Where the card's own thumbnail is (MEDIA_BAND: inset from the card's edges like the picture), at 16:9, so
        // the picture becomes the video and the card's frame, badge row and edge stay round it.
        const spatial = window.AetherSpatial;
        const band = spatial.MEDIA_BAND;
        const width = rect.width * band.w / spatial.FACE_WIDTH;
        box = { left: rect.left + rect.width * band.x / spatial.FACE_WIDTH, top: rect.top + rect.height * band.y / spatial.FACE_HEIGHT, width, height: width * 9 / 16 };
      } else {
        const width = Math.min(720, window.innerWidth * 0.92);
        const height = width * 9 / 16;
        box = { left: (window.innerWidth - width) / 2, top: Math.max(110, (window.innerHeight - height) / 2), width, height };
      }
      // Always wholly on screen, even when its card is partly off an edge.
      box.left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - box.width - 8));
      box.top = Math.min(Math.max(8, box.top), Math.max(8, window.innerHeight - box.height - 8));
      Object.assign(mediaPlayer.style, { left: Math.round(box.left) + 'px', top: Math.round(box.top) + 'px', width: Math.round(box.width) + 'px', height: Math.round(box.height) + 'px' });
      // On a card it has the thumbnail's small corners (8 of the face's 512 px) and no frame of its own (the card's is
      // round it); floating, the panels' radius and a teal hairline.
      mediaPlayer.classList.toggle('on-card', onCard);
      if (onCard) mediaPlayer.style.setProperty('--media-radius', Math.max(4, rect.width * 8 / window.AetherSpatial.FACE_WIDTH).toFixed(1) + 'px');
      else mediaPlayer.style.removeProperty('--media-radius');
      mediaFrameLoop = requestAnimationFrame(placeMedia);
    };
    // The card link in the node card plays in place instead of opening a tab when the video plays inside Aether.
    cardLink.addEventListener('click', event => {
      if (!cardLink.dataset.play || !focus.node) return;
      event.preventDefault();
      playMedia(focus.node);
    });
    // A tap on the thumbnail band of the focused card, on its 3D face, plays its video. Returns whether it did.
    // On the Horizon wall (no card open) a click anywhere on a playable card plays it there, with no zoom to Atomic; a
    // click on the card that is already playing opens it (Atomic) and the video plays on. An open card plays from a tap
    // on its thumbnail band.
    const playFromFace = node => {
      const onWall = !focus.node && gallery && gallery.ids.has(String(node.id)) && !xrPresenting();
      if (!(onWall || focus.node === node) || !isPlayableLink(node.url) || !THREE) return false;
      if (onWall) {
        if (playing && playing.id === String(node.id)) return false;
        playMedia(node, { wall: true });
        return true;
      }
      if (!lastPointer) return false;
      const root = node.__threeObj;
      if (!root) return false;
      const rect = Graph.renderer().domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(((lastPointer.x - rect.left) / rect.width) * 2 - 1, -((lastPointer.y - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, Graph.camera());
      const hit = raycaster.intersectObject(root, true).find(item => item.uv && item.object.material && item.object.material.map);
      if (!hit) return false;
      const spatial = window.AetherSpatial;
      const x = hit.uv.x * spatial.FACE_WIDTH;
      const y = (1 - hit.uv.y) * spatial.FACE_HEIGHT;
      const band = spatial.MEDIA_BAND;
      if (x < band.x || x > band.x + band.w || y < band.y || y > band.y + band.h) return false;
      playMedia(node);
      return true;
    };

    // ---- Headset lens barrel (PROJECT_STATE.md, radial controls; public/js/spatial/xr-barrel.js): solid rings above the
    // left wrist, or pinned at waist height. View rim (Space, Gallery, Board), then the Board's Layout or Time, then
    // Depth and Show; the hub switches Simple and Advanced; keys below hold Back, Recenter, Zoom, Room (MR), Pin and
    // Exit. X shows or hides it. The right hand's ray takes hold of a ring with the trigger or grip and turns it. ----
    let xrBarrel = null;
    let xrPlacementKind = 'overview';
    let xrDarkRoom = false;
    let xrDarkShell = null;
    let xrBoardLabels = null;
    // The Board wall in a headset: it fits this width and height, standing this far away.
    const XR_BOARD_WIDTH_M = 2.4;
    const XR_BOARD_HEIGHT_M = 1.4;
    const XR_BOARD_DISTANCE_M = 1.7;
    const XR_BOARD_LABEL_BOOST = 1.4;
    const XR_ZOOM_STEP = 1.4;
    const xrBarrelRingDefs = () => {
      const defs = wheelRingDefs();
      defs.view = { name: 'View', stops: [
        { value: 'space', label: 'Space' },
        { value: 'gallery', label: 'Gallery' },
        { value: 'board', label: 'Board' }
      ] };
      return defs;
    };
    const xrBarrelState = () => ({
      view: gallery ? 'gallery' : filterState.flat ? 'board' : 'space',
      layout: filterState.boardMode,
      time: filterState.horizon,
      depth: filterState.depth,
      filters: filterState.platform,
      simple: wheelSimple(),
      passthrough: xr && xr.mode() === 'immersive-ar' ? !xrDarkRoom : null
    });
    const xrOnGrab = (ray, hand) => {
      if (!xrBarrel) return false;
      xrPick(ray);
      return xrBarrel.grab(xrRaycaster, hand);
    };
    const xrOnDrag = (ray, hand) => {
      if (!xrBarrel || !xrRaycaster) return;
      xrRaycaster.set(ray.origin, ray.direction);
      xrBarrel.drag(xrRaycaster, hand);
    };
    const xrBarrelChange = (ring, value) => {
      if (ring === 'view') xrSetView(value === 'board' ? filterState.boardMode : value);
      else if (ring === 'layout') xrSetView(value);
      else if (ring === 'time') {
        setScope(value);
        xrRecenter();
      } else if (ring === 'depth') setDepth(value);
      else if (ring === 'filters') {
        const pill = document.querySelector('.platform-pill[data-platform="' + value + '"]');
        if (pill && !pill.disabled) pill.click();
      }
    };
    const setFlat = on => {
      if (filterState.flat !== on) viewToggle.click();
    };
    const xrPlaceBoard = () => {
      if (!boardState) return;
      const scale = Math.max(boardState.width / XR_BOARD_WIDTH_M, boardState.height / XR_BOARD_HEIGHT_M, 5);
      xrPlacementKind = 'board';
      if (cardField) {
        cardField.setGlobalScale(1);
        cardField.setUnitsPerMetre(scale);
      }
      xr.place(head => xr.placement({ point: { x: 0, y: 0.1 * scale, z: XR_BOARD_DISTANCE_M * scale }, yaw: 0, scale, head }));
    };
    const xrRecenter = () => {
      if (xrPlacementKind === 'board' && filterState.flat) xrPlaceBoard();
      else if (xrPlacementKind === 'gallery' && gallery) xrPlaceGallery();
      else xrPlaceOverview();
    };
    // After a zoom: the world scale changed, so physical sizes follow (and overview cards keep their size).
    const xrOnScale = scale => {
      if (!cardField) return;
      cardField.setUnitsPerMetre(scale);
      if (xrPlacementKind === 'overview') {
        cardField.setGlobalScale(Math.min(XR_OVERVIEW_CARD_MAX, Math.max(1, XR_OVERVIEW_CARD_M / (window.AetherSpatial.CARD_WIDTH / scale))));
      }
    };
    // In mixed reality, "Room off" puts a dark shell around the head: the look of VR without restarting the session.
    const setDarkRoom = on => {
      xrDarkRoom = Boolean(on);
      if (!xrDarkShell && on && THREE) {
        xrDarkShell = new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshBasicMaterial({ color: XR_VR_BACKGROUND, side: THREE.BackSide, depthTest: false, depthWrite: false })
        );
        xrDarkShell.renderOrder = -1000;
        xrDarkShell.frustumCulled = false;
        xrDarkShell.raycast = () => {};
        Graph.camera().add(xrDarkShell);
      }
      if (xrDarkShell) xrDarkShell.visible = xrDarkRoom;
    };
    // The Board wall's column headers are web page elements, which a headset does not show; there they are 3D labels.
    const syncXrBoardLabels = () => {
      const want = xrPresenting() && filterState.flat && boardState && boardState.columns.length ? boardState : null;
      if (!xrBoardLabels || xrBoardLabels.source !== want) {
        if (xrBoardLabels) {
          xrBoardLabels.group.children.forEach(sprite => {
            sprite.material.map.dispose();
            sprite.material.dispose();
          });
          Graph.scene().remove(xrBoardLabels.group);
          xrBoardLabels = null;
        }
        if (!want || !THREE) return;
        const group = new THREE.Group();
        want.columns.forEach(column => {
          const sprite = makeLabelSprite(column.label, getBoardColumnColor(column.key));
          sprite.position.set(column.x, column.headerY, 1);
          sprite.raycast = () => {};
          group.add(sprite);
        });
        Graph.scene().add(group);
        xrBoardLabels = { group, source: want };
      }
      const scale = labelScale() * XR_BOARD_LABEL_BOOST;
      xrBoardLabels.group.children.forEach(sprite => sprite.scale.set(LABEL_WIDTH * scale, LABEL_HEIGHT * scale, 1));
    };
    // The card for the Gallery view: the focused one, else the one a ray is on, else the newest shown.
    const xrGalleryCard = () => {
      if (focus.node) return focus.node;
      const hovered = xrHovered.get(1) || xrHovered.get(0);
      if (hovered) return hovered;
      return Graph.graphData().nodes.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
    };
    // A spatial view: 'space', 'gallery', or a Board layout ('groups', 'status', 'map', 'timeline').
    const xrSetView = value => {
      if (value === 'space') {
        if (gallery || focus.node) resetSelection();
        setFlat(false);
        xrPlaceOverview();
      } else if (value === 'gallery') {
        const node = xrGalleryCard();
        setFlat(false);
        if (!node) return;
        focusCard(node);
        if (gallery) {
          cardField.setGallerySlide(gallery.radius * XR_FOCUS_SLIDE);
          xrPlaceGallery();
        }
      } else {
        if (gallery || focus.node) resetSelection();
        const button = boardModeButtons.find(item => item.dataset.boardMode === value);
        if (button && filterState.boardMode !== value) button.click();
        setFlat(true);
        layoutBoard();
        xrPlaceBoard();
      }
    };
    // The barrel's hub (the wheel mode) and keys.
    const xrAction = id => {
      if (id === 'mode') {
        setWheelMode(wheelSimple() ? 'advanced' : 'simple');
      } else if (id === 'back') {
        if (gallery || focus.node) xrOnBack();
        else if (filterState.flat) {
          setFlat(false);
          xrPlaceOverview();
        }
      } else if (id === 'recenter') {
        xrRecenter();
      } else if (id === 'zoom-in') {
        xr.zoomBy(1 / XR_ZOOM_STEP);
      } else if (id === 'zoom-out') {
        xr.zoomBy(XR_ZOOM_STEP);
      } else if (id === 'passthrough') {
        setDarkRoom(!xrDarkRoom);
      } else if (id === 'pin') {
        xrBarrel.setPinned(!xrBarrel.isPinned());
      } else if (id === 'exit') {
        xr.end();
      }
    };

    xrButton.addEventListener('click', event => {
      event.stopPropagation();
      if (!xrBothModes) {
        enterXR();
        return;
      }
      xrMenu.hidden = !xrMenu.hidden;
    });
    xrMenu.addEventListener('click', event => {
      const choice = event.target.closest('[data-xr-mode]');
      if (choice) enterXR(choice.dataset.xrMode);
    });
    document.addEventListener('click', event => {
      if (!xrMenu.hidden && !event.target.closest('.xr-wrap')) xrMenu.hidden = true;
    });

    // ---- Graph size. The library reads window.innerWidth and innerHeight once, when its script loads, and never again;
    // on the Quest Browser (and any window resized after load) that left the canvas and camera with a stale aspect
    // ratio, stretching the graph. The graph is sized from its container's real bounds, whenever the window, the
    // visual viewport or the container changes size; the library then resizes its renderer and camera to match. ----
    const fitGraphToContainer = () => {
      if (xrPresenting()) return;
      const rect = graphElement.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      // Hidden (List, Timeline, Board or Carousel view): keep the last size until the graph is shown again.
      if (!width || !height) return;
      // The graph library reads the pixel density once, at start-up; a browser zoom or a move to another display
      // changes it, and the canvas would then be stretched (blurred) or wastefully oversized. Capped at 2 like the
      // library does; the composer's passes follow the renderer.
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const renderer = Graph.renderer();
      const densityChanged = renderer.getPixelRatio() !== pixelRatio;
      if (densityChanged) {
        renderer.setPixelRatio(pixelRatio);
        const composer = Graph.postProcessingComposer && Graph.postProcessingComposer();
        if (composer && composer.setPixelRatio) composer.setPixelRatio(pixelRatio);
      }
      if (!densityChanged && Graph.width() === width && Graph.height() === height) return;
      // Same size with a new density: setSize re-applies it to the canvas's drawing buffer.
      if (densityChanged && Graph.width() === width && Graph.height() === height) renderer.setSize(width, height, false);
      Graph.width(width).height(height);
    };
    let fitGraphFrame = 0;
    const scheduleGraphFit = () => {
      if (!fitGraphFrame) fitGraphFrame = requestAnimationFrame(() => {
        fitGraphFrame = 0;
        fitGraphToContainer();
      });
    };
    window.addEventListener('resize', scheduleGraphFit);
    window.addEventListener('orientationchange', scheduleGraphFit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleGraphFit);
    if (window.ResizeObserver) new ResizeObserver(scheduleGraphFit).observe(graphElement);
    window.addEventListener('load', scheduleGraphFit);
    // A move to a display of another density fires no resize when the window keeps its size.
    const watchPixelDensity = () => {
      if (!window.matchMedia) return;
      const query = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      const onChange = () => {
        query.removeEventListener('change', onChange);
        scheduleGraphFit();
        watchPixelDensity();
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
    };
    watchPixelDensity();
    scheduleGraphFit();

    // ---- 2D board (SPATIAL_ARCHITECTURE.md 3, Phase 5). The 2D mode is a morph: the same cards glide from their 3D
    // positions into a node-editor board, one column per group (layout-2d.js), and turn flat to face the camera. The
    // force layout is never moved, so going back to 3D returns every card to its island. Dragging a card onto another
    // column regroups it (the group picker's action); the regrouped card also moves to that group's island in 3D. ----
    let boardState = null;
    const boardHeaders = document.getElementById('board-headers');
    const boardHint = document.getElementById('board-hint');
    // The smallest a card is framed on screen, in pixels: a bigger board is framed from its top-left corner and panned.
    const BOARD_MIN_CARD_PX = 56;
    // Zoom limits on the board: cards between these heights on screen, in pixels.
    const BOARD_ZOOM_PX = { min: 20, max: 400 };
    const BOARD_MARGIN = 8;
    const BOARD_DRAG_PX = 6;

    // Where cards were dragged on the map; they keep those spots until the map is laid out from scratch.
    const mapMoves = new Map();
    const STATUS_KEY_PREFIX = 'status:';
    const layoutBoard = () => {
      if (!filterState.flat || !cardField || !window.AetherSpatial) return;
      const spatial = window.AetherSpatial;
      const size = { cardWidth: spatial.CARD_WIDTH, cardHeight: spatial.CARD_HEIGHT };
      const nodes = Graph.graphData().nodes;
      if (filterState.boardMode === 'map') {
        const links = Graph.graphData().links.map(link => ({ source: linkEndId(link.source), target: linkEndId(link.target), type: link.type }));
        const map = spatial.mapLayout(nodes.map(node => String(node.id)), links, size);
        mapMoves.forEach((position, id) => { if (map.slots.has(id)) map.slots.set(id, { ...position }); });
        boardState = { slots: map.slots, columns: [], wires: map.wires, width: map.width, height: map.height };
      } else if (filterState.boardMode === 'timeline') {
        const [items, options] = timelineItems(nodes);
        boardState = spatial.boardLayout(items, { ...size, ...options });
      } else if (filterState.boardMode === 'status') {
        const items = nodes.map(node => ({ id: String(node.id), key: STATUS_KEY_PREFIX + getNodeStatus(node), status: getNodeStatus(node), created: node.created_at }));
        boardState = spatial.boardLayout(items, { ...size, columns: BOARD_COLUMNS.map(column => ({ key: STATUS_KEY_PREFIX + column.status, label: column.icon + ' ' + column.label })) });
      } else {
        // A column per primary group (its group, or its type while it has none), whatever Group by says, so every
        // column is a place a card can be dropped.
        const items = nodes.map(node => {
          const key = spatial.primaryGroup(node);
          return { id: String(node.id), key, label: getBoardColumnLabel(key), status: node.status, created: node.created_at };
        });
        boardState = spatial.boardLayout(items, size);
      }
      cardField.setBoard(boardState.slots);
      renderBoardHeaders();
      buildWires();
    };
    // Timeline layout: a column per day, week or month (whichever fits the span shown), oldest on the left.
    const TIMELINE_DAY_SPAN = 14;
    const TIMELINE_WEEK_SPAN = 120;
    const pad2 = value => String(value).padStart(2, '0');
    const isoDay = date => date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    const timelineItems = nodes => {
      const times = nodes.map(getNodeTime).filter(Number.isFinite);
      const span = times.length ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;
      const unit = span <= TIMELINE_DAY_SPAN ? 'day' : span <= TIMELINE_WEEK_SPAN ? 'week' : 'month';
      const bucket = time => {
        if (!Number.isFinite(time)) return { key: 'time:~undated', label: 'Undated' };
        const date = new Date(time);
        if (unit === 'day') return { key: 'time:' + isoDay(date), label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
        if (unit === 'week') {
          const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
          return { key: 'time:' + isoDay(start), label: 'Week of ' + start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
        }
        return { key: 'time:' + date.getFullYear() + '-' + pad2(date.getMonth() + 1), label: date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) };
      };
      const columns = new Map();
      const items = nodes.map(node => {
        const place = bucket(getNodeTime(node));
        columns.set(place.key, place.label);
        return { id: String(node.id), key: place.key, label: place.label, created: node.created_at };
      });
      const ordered = [...columns].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, label]) => ({ key, label }));
      return [items, { columns: ordered }];
    };
    const getBoardColumnLabel = key => {
      if (key.startsWith('group:')) {
        const group = (graphData.groups || []).find(item => 'group:' + item.id === key);
        return group ? (group.source === 'ai' ? '✦ ' : '') + group.name : 'Group';
      }
      return key.slice(key.indexOf(':') + 1).replace(/_/g, ' ');
    };
    const getBoardColumnColor = key => {
      if (!key.startsWith(STATUS_KEY_PREFIX)) return getClusterColor(key);
      const column = BOARD_COLUMNS.find(item => item.status === key.slice(STATUS_KEY_PREFIX.length));
      return column ? column.color : FALLBACK_CATEGORY_COLOR;
    };

    // ---- Map wires: node-editor Bezier curves between wired cards, drawn as thin flat ribbons on the board plane and
    // re-shaped every frame from where the cards are drawn, so they follow the morph and any drag. ----
    const WIRE_SEGMENTS = 20;
    // Ribbon width as a share of a card's width, and how far behind the cards it lies.
    const WIRE_WIDTH_SHARE = 0.03;
    const WIRE_DEPTH = 0.3;
    const WIRE_COLORS = { ai: '#ffd166', synthesis: OUTCOME_COLOR, concept: '#c38bff', semantic: '#6fc3e8' };
    const WIRE_DEFAULT_COLOR = '#9fe8dc';
    let wireMesh = null;
    const buildWires = () => {
      if (wireMesh) {
        Graph.scene().remove(wireMesh);
        wireMesh.geometry.dispose();
        wireMesh.material.dispose();
        wireMesh = null;
      }
      if (!filterState.flat || filterState.boardMode !== 'map' || !boardState || !boardState.wires || !boardState.wires.length) return;
      if (typeof THREE === 'undefined' || !THREE) return;
      const wires = boardState.wires;
      const perWire = (WIRE_SEGMENTS + 1) * 2;
      const positions = new Float32Array(wires.length * perWire * 3);
      const colors = new Float32Array(wires.length * perWire * 3);
      const indices = [];
      const color = new THREE.Color();
      wires.forEach((wire, w) => {
        color.set(WIRE_COLORS[wire.type] || WIRE_DEFAULT_COLOR);
        const base = w * perWire;
        for (let v = 0; v < perWire; v++) colors.set([color.r, color.g, color.b], (base + v) * 3);
        for (let i = 0; i < WIRE_SEGMENTS; i++) {
          const a = base + i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      wireMesh = new THREE.Mesh(geometry, material);
      wireMesh.frustumCulled = false;
      wireMesh.renderOrder = -2;
      // Decoration: never the target of a click.
      wireMesh.raycast = () => {};
      Graph.scene().add(wireMesh);
    };
    const updateWires = () => {
      if (!wireMesh || !boardState || !boardState.wires) return;
      const spatial = window.AetherSpatial;
      const weight = cardField.boardWeight();
      wireMesh.material.opacity = 0.8 * Math.max(0, (weight - 0.4) / 0.6);
      const half = (spatial.CARD_WIDTH * WIRE_WIDTH_SHARE) / 2;
      const positions = wireMesh.geometry.attributes.position.array;
      const perWire = (WIRE_SEGMENTS + 1) * 2;
      boardState.wires.forEach((wire, w) => {
        const from = cardField.displayPosition(wire.source);
        const to = cardField.displayPosition(wire.target);
        const base = w * perWire * 3;
        if (!from || !to) {
          positions.fill(0, base, base + perWire * 3);
          return;
        }
        const points = spatial.wirePoints(from, to, { cardWidth: spatial.CARD_WIDTH, segments: WIRE_SEGMENTS });
        points.forEach((point, i) => {
          const prev = points[Math.max(0, i - 1)];
          const next = points[Math.min(points.length - 1, i + 1)];
          const tx = next.x - prev.x;
          const ty = next.y - prev.y;
          const length = Math.hypot(tx, ty) || 1;
          const nx = (-ty / length) * half;
          const ny = (tx / length) * half;
          const z = Math.min(from.z, to.z) - WIRE_DEPTH;
          const offset = base + i * 6;
          positions[offset] = point.x + nx;
          positions[offset + 1] = point.y + ny;
          positions[offset + 2] = z;
          positions[offset + 3] = point.x - nx;
          positions[offset + 4] = point.y - ny;
          positions[offset + 5] = z;
        });
      });
      wireMesh.geometry.attributes.position.needsUpdate = true;
    };

    // Share of the canvas height the top bar and filter row cover.
    const getTopChrome = () => {
      const canvas = Graph.renderer().domElement.getBoundingClientRect();
      if (!canvas.height) return 0;
      const bottoms = [document.getElementById('topbar'), document.getElementById('filter-toolbar')]
        .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => rect.bottom - canvas.top);
      return Math.min(0.4, Math.max(0, ...bottoms) / canvas.height);
    };
    // Share of the canvas height the board's layout switcher (and its gap) covers at the bottom.
    const getBottomChrome = () => {
      const canvas = Graph.renderer().domElement.getBoundingClientRect();
      const rect = document.getElementById('board-modes').getBoundingClientRect();
      if (!canvas.height || !rect.height) return 0;
      return Math.min(0.3, Math.max(0, canvas.bottom - rect.top + 12) / canvas.height);
    };
    // Front-on framing of the board between the top chrome and the layout switcher; a board too big to read whole
    // starts at its top-left.
    const getBoardFraming = (vFov, hFov) => {
      const tanV = Math.tan(vFov / 2);
      const tanH = Math.tan(hFov / 2);
      const chrome = getTopChrome();
      const bottom = getBottomChrome();
      const halfW = boardState.width / 2 + BOARD_MARGIN;
      const halfH = boardState.height / 2 + BOARD_MARGIN;
      const fit = Math.max(halfH / ((1 - chrome - bottom) * tanV), halfW / tanH);
      const canvasHeight = Graph.renderer().domElement.clientHeight || window.innerHeight;
      const readable = (window.AetherSpatial.CARD_HEIGHT * canvasHeight) / (2 * tanV * BOARD_MIN_CARD_PX);
      if (fit <= readable) return { center: { x: 0, y: (chrome - bottom) * fit * tanV, z: 0 }, distance: fit };
      const visibleHalfW = readable * tanH;
      const visibleHalfH = readable * tanV;
      return {
        // Its top edge just below the top chrome, and its left edge at the left of the screen (or centred when narrower).
        center: { x: Math.min(0, -halfW + visibleHalfW), y: halfH - visibleHalfH + 2 * chrome * visibleHalfH, z: 0 },
        distance: readable
      };
    };

    const renderBoardHeaders = () => {
      boardHeaders.replaceChildren(...(boardState ? boardState.columns : []).map(column => {
        const header = document.createElement('div');
        header.className = 'board-header';
        header.style.borderTopColor = getBoardColumnColor(column.key);
        const groupId = column.key.startsWith('group:') ? column.key.slice('group:'.length) : null;
        if (groupId && !groupId.startsWith('pending_')) {
          header.classList.add('renamable');
          header.title = 'Rename group';
          header.addEventListener('click', () => startGroupRename(header, groupId));
        }
        const label = document.createElement('span');
        label.className = 'board-header-label';
        label.textContent = column.label;
        const count = document.createElement('span');
        count.className = 'board-header-count';
        count.textContent = String(column.count);
        header.append(label, count);
        return header;
      }));
      startBoardHeaders();
    };
    let boardHeaderFrame = 0;
    const placeBoardHeaders = () => {
      boardHeaderFrame = 0;
      const weight = cardField ? cardField.boardWeight() : 0;
      if (!filterState.flat && weight < 0.02) {
        boardHeaders.hidden = true;
        return;
      }
      boardHeaderFrame = requestAnimationFrame(placeBoardHeaders);
      const ready = boardState && weight > 0.02 && filterState.view === 'graph' && typeof THREE !== 'undefined' && THREE;
      boardHeaders.hidden = !ready;
      if (!ready) return;
      const camera = Graph.camera();
      const rect = Graph.renderer().domElement.getBoundingClientRect();
      const centre = new THREE.Vector3();
      const edge = new THREE.Vector3();
      // The headers arrive with the cards: they fade in over the last part of the morph.
      boardHeaders.style.opacity = String(Math.max(0, (weight - 0.5) * 2));
      [...boardHeaders.children].forEach((header, index) => {
        const column = boardState.columns[index];
        if (!column) return;
        centre.set(column.x, column.headerY, 0).project(camera);
        edge.set(column.right, column.headerY, 0).project(camera);
        const x = rect.left + ((centre.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - centre.y) / 2) * rect.height;
        header.style.maxWidth = Math.max(36, Math.round(Math.abs(edge.x - centre.x) * rect.width)) + 'px';
        header.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px) translate(-50%, -50%)';
      });
    };
    const startBoardHeaders = () => {
      if (!boardHeaderFrame) boardHeaderFrame = requestAnimationFrame(placeBoardHeaders);
    };

    // The board's toast. With undo, it offers Undo for a few seconds longer.
    const boardHintText = document.getElementById('board-hint-text');
    const boardHintUndo = document.getElementById('board-hint-undo');
    let boardHintTimer = null;
    let boardHintAction = null;
    const showBoardHint = (text, undo = null) => {
      boardHintText.textContent = text;
      boardHintAction = undo;
      boardHintUndo.hidden = !undo;
      boardHint.hidden = false;
      clearTimeout(boardHintTimer);
      boardHintTimer = setTimeout(() => {
        boardHint.hidden = true;
        boardHintAction = null;
      }, undo ? 6000 : 3500);
    };
    boardHintUndo.addEventListener('click', () => {
      const undo = boardHintAction;
      boardHintAction = null;
      boardHint.hidden = true;
      clearTimeout(boardHintTimer);
      if (undo) undo();
    });

    // Renaming a group from its column header: the header's label becomes a text field; Enter or leaving it saves,
    // Escape cancels. Optimistic, like the group picker: a failed save puts the old name back.
    const renameGroup = async (groupId, name) => {
      const group = (graphData.groups || []).find(item => item.id === groupId);
      const clean = String(name || '').trim().split(' ').filter(Boolean).join(' ');
      if (!group || !clean || clean === group.name) return;
      const before = { name: group.name, source: group.source };
      group.name = clean;
      group.source = 'user';
      reclusterLive();
      try {
        await apiFetch('/api/groups/' + encodeURIComponent(groupId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: clean })
        });
      } catch (err) {
        console.error('Group rename failed:', err);
        group.name = before.name;
        group.source = before.source;
        reclusterLive();
        showBoardHint(err.message || 'Renaming the group failed.');
      }
    };
    const startGroupRename = (header, groupId) => {
      const group = (graphData.groups || []).find(item => item.id === groupId);
      if (!group || header.querySelector('input')) return;
      const label = header.querySelector('.board-header-label');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 60;
      input.value = group.name;
      input.setAttribute('aria-label', 'Group name');
      label.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = save => {
        if (done) return;
        done = true;
        const value = input.value;
        input.replaceWith(label);
        if (save) renameGroup(groupId, value);
      };
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
        event.stopPropagation();
      });
      input.addEventListener('blur', () => finish(true));
    };

    const boardModeButtons = [...document.querySelectorAll('#board-modes [data-board-mode]')];
    const renderBoardModes = () => {
      syncThumbWheel();
      boardModeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.boardMode === filterState.boardMode)));
    };
    renderBoardModes();
    boardModeButtons.forEach(button => button.addEventListener('click', () => {
      const mode = button.dataset.boardMode;
      if (!BOARD_MODES.includes(mode) || mode === filterState.boardMode) return;
      filterState.boardMode = mode;
      saveViewPrefs();
      renderBoardModes();
      if (focus.node) hideNodeCard();
      boardHint.hidden = true;
      layoutBoard();
      resetCameraView();
    }));

    let savedZoomLimits = null;
    const setBoardMode = on => {
      // Not 'board-mode', which is the status Board view's own class.
      document.body.classList.toggle('flat-board', on);
      if (!cardField) return;
      cardField.setLodMode(getLodMode());
      if (territories.group) territories.group.visible = !on && !focus.node;
      const controls = Graph.controls();
      if (on) {
        Graph.linkVisibility(false);
        layoutBoard();
        const tanV = Math.tan(cameraFov() / 2);
        const canvasHeight = Graph.renderer().domElement.clientHeight || window.innerHeight;
        const distanceFor = px => (window.AetherSpatial.CARD_HEIGHT * canvasHeight) / (2 * tanV * px);
        if (!savedZoomLimits) savedZoomLimits = { min: controls.minDistance, max: controls.maxDistance };
        controls.minDistance = distanceFor(BOARD_ZOOM_PX.max);
        controls.maxDistance = distanceFor(BOARD_ZOOM_PX.min);
      } else {
        cardField.setBoard(null);
        buildWires();
        boardHint.hidden = true;
        if (savedZoomLimits) {
          controls.minDistance = savedZoomLimits.min;
          controls.maxDistance = savedZoomLimits.max;
          savedZoomLimits = null;
        }
        // Links reappear once the cards are most of the way back on their islands.
        setTimeout(() => { if (!filterState.flat && !gallery) Graph.linkVisibility(true); }, 450);
      }
    };

    // Board point (on the z = 0 plane) under a pointer event, and the card whose slot contains it.
    const boardPointer = event => {
      if (typeof THREE === 'undefined' || !THREE) return null;
      const rect = Graph.renderer().domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, Graph.camera());
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit) ? { x: hit.x, y: hit.y } : null;
    };
    const boardCardAt = point => {
      const spatial = window.AetherSpatial;
      for (const [id, slot] of boardState.slots) {
        if (Math.abs(point.x - slot.x) <= spatial.CARD_WIDTH / 2 && Math.abs(point.y - slot.y) <= spatial.CARD_HEIGHT / 2) return id;
      }
      return null;
    };

    // A card dropped on another column joins that group. Under "Group by: Group" a column is a group, or the type
    // (category) of cards that have none, so a card can leave its group only for its own type's column.
    // Moves a card to a place on the board: { groupId } (a group id, or null for none) and/or { category }. Optimistic:
    // the card moves at once and moves back, with the server's reason, if the save fails (a video link stays a video;
    // Outcome cards keep their type). Returns whether it was saved.
    const setCardPlace = async (node, place) => {
      const before = { category: node.category, type: node.type, group: node.group, group_id: node.group_id, group_source: node.group_source };
      const body = {};
      if (place.category !== undefined && place.category !== getNodeCategory(node)) {
        body.category = place.category;
        node.category = place.category;
        node.type = place.category;
        node.group = place.category;
      }
      if (place.groupId !== undefined && place.groupId !== (node.group_id || null)) {
        body.group_id = place.groupId;
        node.group_id = place.groupId;
        node.group_source = 'user';
      }
      if (!Object.keys(body).length) return true;
      reclusterLive();
      try {
        await apiFetch('/api/node/' + encodeURIComponent(node.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        return true;
      } catch (err) {
        console.error('Moving the card failed:', err);
        Object.assign(node, before);
        reclusterLive();
        showBoardHint(err.message || 'Moving the card failed.');
        return false;
      }
    };

    // A card dropped on a column goes there, whichever column it is: onto a group's column it joins that group; onto a
    // type's column it takes that type and leaves its group; onto a status column it takes that status. Every move
    // offers Undo.
    const dropOnColumn = async (node, column) => {
      const title = node.title || 'Card';
      if (column.key.startsWith(STATUS_KEY_PREFIX)) {
        const status = column.key.slice(STATUS_KEY_PREFIX.length);
        const previous = getNodeStatus(node);
        if (status === previous) return;
        moveNodeToStatus(node, status);
        showBoardHint(title + ' moved to ' + column.label + '.', () => moveNodeToStatus(node, previous));
        return;
      }
      // Dates are facts, not places: the Timeline only shows them.
      if (column.key.startsWith('time:')) return;
      if (column.key === window.AetherSpatial.primaryGroup(node)) return;
      const previous = { category: getNodeCategory(node), groupId: node.group_id || null };
      const place = column.key.startsWith('group:')
        ? { groupId: column.key.slice('group:'.length) }
        : { category: column.key.slice(column.key.indexOf(':') + 1), groupId: null };
      if (await setCardPlace(node, place)) {
        showBoardHint(title + ' moved to ' + column.label + '.', () => setCardPlace(node, previous));
      }
    };

    // Touch has to hold a card still for BOARD_HOLD_MS before it lifts (with a short buzz where supported), so a pan
    // that starts on a card stays a pan; moving more than BOARD_HOLD_SLOP_PX first cancels it. A mouse drags as soon
    // as it moves BOARD_DRAG_PX.
    const BOARD_HOLD_MS = 280;
    const BOARD_HOLD_SLOP_PX = 10;
    let boardCardDrag = null;
    const cancelBoardHold = () => {
      if (!boardCardDrag || boardCardDrag.armed) return;
      clearTimeout(boardCardDrag.timer);
      boardCardDrag = null;
    };
    const armBoardDrag = () => {
      if (!boardCardDrag) return;
      boardCardDrag.armed = true;
      // The press belongs to the card now: the orbit controls must not pan with it.
      Graph.controls().enabled = false;
      const slot = boardState.slots.get(boardCardDrag.id);
      if (slot) cardField.setBoardSlot(boardCardDrag.id, { ...slot, z: window.AetherSpatial.CARD_WIDTH * 0.25 }, true);
      if (boardCardDrag.touch && navigator.vibrate) {
        try { navigator.vibrate(12); } catch (err) {}
      }
    };
    // Registered after cancelCameraFlight (also a capture listener), so the controls stay off for a card press.
    graphElement.addEventListener('pointerdown', event => {
      if (!event.isPrimary) {
        // A second finger (a pinch) is never a card drag.
        cancelBoardHold();
        return;
      }
      if (!filterState.flat || !boardState || !cardField || filterState.view !== 'graph' || event.button !== 0) return;
      if (cardField.boardWeight() < 0.95) return;
      const point = boardPointer(event);
      const id = point && boardCardAt(point);
      if (!id) return;
      const slot = boardState.slots.get(id);
      const touch = event.pointerType !== 'mouse';
      boardCardDrag = { id, x: event.clientX, y: event.clientY, offset: { x: slot.x - point.x, y: slot.y - point.y }, moved: false, armed: false, touch, timer: null };
      if (touch) boardCardDrag.timer = setTimeout(armBoardDrag, BOARD_HOLD_MS);
      else armBoardDrag();
    }, { capture: true, passive: true });
    window.addEventListener('pointermove', event => {
      if (!boardCardDrag) return;
      const distance = Math.hypot(event.clientX - boardCardDrag.x, event.clientY - boardCardDrag.y);
      if (!boardCardDrag.armed) {
        if (distance > BOARD_HOLD_SLOP_PX) cancelBoardHold();
        return;
      }
      if (!boardCardDrag.moved && distance < BOARD_DRAG_PX) return;
      const point = boardPointer(event);
      if (!point) return;
      boardCardDrag.moved = true;
      boardCardDrag.point = point;
      document.body.classList.add('board-card-dragging');
      // Lifted a little toward the camera so it passes over the other cards.
      cardField.setBoardSlot(boardCardDrag.id, { x: point.x + boardCardDrag.offset.x, y: point.y + boardCardDrag.offset.y, z: window.AetherSpatial.CARD_WIDTH * 0.25 }, true);
    }, { passive: true });
    const endBoardCardDrag = event => {
      if (!boardCardDrag) return;
      const drag = boardCardDrag;
      boardCardDrag = null;
      clearTimeout(drag.timer);
      document.body.classList.remove('board-card-dragging');
      if (!(cameraRig && cameraRig.active)) Graph.controls().enabled = true;
      // A press without a drag is a tap: the graph's own click opens the card (a held card settles back first).
      if (!drag.moved) {
        if (drag.armed) layoutBoard();
        return;
      }
      ignoreClickUntil = Date.now() + 500;
      const dropped = cardField.boardSlot(drag.id);
      if (dropped) cardField.setBoardSlot(drag.id, { ...dropped, z: 0 }, false);
      // On the map a card simply stays where it is put.
      if (filterState.boardMode === 'map') {
        if (dropped) mapMoves.set(drag.id, { x: dropped.x, y: dropped.y, z: 0 });
        layoutBoard();
        return;
      }
      const node = Graph.graphData().nodes.find(item => String(item.id) === drag.id);
      const point = event && event.type === 'pointerup' ? boardPointer(event) || drag.point : drag.point;
      const column = point && boardState ? window.AetherSpatial.columnAt(boardState, point.x) : null;
      if (node && column && event && event.type === 'pointerup') dropOnColumn(node, column);
      // Back to its slot (in its new column, once regrouped), gliding from where it was let go.
      layoutBoard();
    };
    window.addEventListener('pointerup', endBoardCardDrag, { passive: true });
    window.addEventListener('pointercancel', endBoardCardDrag, { passive: true });

    const viewToggle = document.getElementById('view-toggle');
    viewToggle.addEventListener('click', () => {
      if (gallery) closeClusterDrawer();
      if (focus.node) hideNodeCard();
      filterState.flat = !filterState.flat;
      viewToggle.querySelector('.bar-label').textContent = filterState.flat ? '3D Space' : '2D Board';
      viewToggle.dataset.short = filterState.flat ? '3D' : '2D';
      viewToggle.classList.toggle('active', filterState.flat);
      pinToPlane(graphData.nodes);
      setBoardMode(filterState.flat);
      syncThumbWheel();

      const controls = Graph.controls();
      // Trackball controls (the default) use noRotate; orbit controls use enableRotate.
      controls.noRotate = filterState.flat;
      controls.enableRotate = !filterState.flat;
      // In 2D, left-drag pans instead of rotating (THREE.MOUSE: 0 = rotate, 2 = pan).
      if (controls.mouseButtons) controls.mouseButtons.LEFT = filterState.flat ? 2 : 0;
      // Same for one-finger touch, which would otherwise do nothing with rotation off (THREE.TOUCH: 0 = rotate, 1 = pan).
      if (controls.touches) controls.touches.ONE = filterState.flat ? 1 : 0;

      pauseAutoRotate();
      // Front-on over the board, or back to the whole 3D cloud (again once regrouped cards have settled).
      resetCameraView();
      if (!filterState.flat) scheduleFit();
    });

    const typeFilter = document.getElementById('type-filter');
    typeFilter.addEventListener('change', () => {
      filterState.type = typeFilter.value || 'all';
      applyGraphFilters();
      reframeAfterFilter();
    });

    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', () => {
      filterState.query = searchInput.value.trim().toLowerCase();
      applyGraphFilters();
      reframeAfterFilter();
    });

    const timeFilter = document.getElementById('time-filter');
    timeFilter.addEventListener('change', () => {
      filterState.horizon = timeFilter.value || 'all';
      applyGraphFilters();
      reframeAfterFilter();
    });

    const clusterToggle = document.getElementById('cluster-toggle');
    clusterToggle.addEventListener('click', () => {
      filterState.clusterMode = filterState.clusterMode === 'category' ? 'rainbow' : 'category';
      clusterToggle.textContent = filterState.clusterMode === 'category' ? 'Category View' : 'Rainbow View';
      clusterToggle.classList.toggle('active', filterState.clusterMode === 'category');
      applyGraphFilters();
    });

    const groupBySelect = document.getElementById('group-by');
    groupBySelect.value = filterState.groupBy;
    groupBySelect.addEventListener('change', () => {
      filterState.groupBy = GROUP_BY_KEYS.includes(groupBySelect.value) ? groupBySelect.value : 'group';
      saveViewPrefs();
      reclusterLive();
      if (filterState.view === 'graph' && !focus.node) scheduleFit();
    });

    // Clustering by group needs the spatial modules, which load after this script: re-run the filters once they do.
    window.addEventListener('aether-spatial-ready', () => {
      if (graphLoaded) applyGraphFilters();
      if (focus.node && nodeCard.style.display === 'block') renderCardGroup(focus.node);
    }, { once: true });

    const orphanToggle = document.getElementById('orphan-toggle');
    orphanToggle.addEventListener('click', () => {
      filterState.hideOrphans = !filterState.hideOrphans;
      orphanToggle.classList.toggle('active', filterState.hideOrphans);
      orphanToggle.setAttribute('aria-pressed', String(filterState.hideOrphans));
      applyGraphFilters();
    });

    const settingsToggle = document.getElementById('settings-toggle');
    const settingsMenu = document.getElementById('settings-menu');
    settingsToggle.addEventListener('click', () => {
      settingsMenu.classList.toggle('open');
    });

    const filterMenu = document.getElementById('filter-menu');
    const settingsWrap = document.querySelector('.settings-wrap');
    document.addEventListener('pointerdown', event => {
      if (filterMenu.open && !filterMenu.contains(event.target)) filterMenu.open = false;
      if (!settingsWrap.contains(event.target)) settingsMenu.classList.remove('open');
    });

    const clearFiltersButton = document.getElementById('clear-filters-button');
    const resetFilters = () => {
      filterState.type = 'all';
      filterState.horizon = 'all';
      filterState.query = '';
      filterState.clusterMode = 'category';
      filterState.highlighted.clear();
      filterState.hideOrphans = false;
      orphanToggle.classList.remove('active');
      orphanToggle.setAttribute('aria-pressed', 'false');
      timeFilter.value = 'all';
      searchInput.value = '';
      clusterToggle.textContent = 'Category View';
      clusterToggle.classList.add('active');
      typeFilter.value = 'all';
      filterState.platform = 'all';
      settingsMenu.classList.remove('open');
      filterMenu.open = false;
      applyGraphFilters();
    };
    clearFiltersButton.addEventListener('click', resetFilters);
    document.getElementById('filters-reset').addEventListener('click', resetFilters);

    const getAdminToken = () => {
      let token = localStorage.getItem(ADMIN_TOKEN_KEY);
      if (!token) {
        token = (window.prompt('Admin token required:') || '').trim();
        if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
      }
      return token;
    };

    // Signed-in JSON request (session cookie); an expired session brings back the login screen.
    const apiFetch = async (path, options = {}) => {
      // The tab's id lets live sync skip this tab's own changes.
      const headers = new Headers(options.headers || {});
      headers.set('X-Aether-Client', LIVE_CLIENT_ID);
      const res = await fetch(path, { ...options, headers });
      if (res.status === 401) {
        showLoginGate();
        throw new Error('Please sign in again.');
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ('Request failed: ' + res.status));
      return body;
    };

    const askElarion = async ({ button, input, output, label, focusId, nodeIds }) => {
      const question = input.value.trim();
      if (!question) {
        input.focus();
        return;
      }
      if (!nodeIds.length) {
        setAskAnswer(output, 'No visible nodes to ask about.', true);
        return;
      }
      button.disabled = true;
      input.value = '';
      const answer = addAskTurn(output, question);
      try {
        const body = await apiFetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, label, focusId, nodeIds: nodeIds.slice(0, ASK_MAX_NODES) })
        });
        answer.textContent = formatAnswer(body.answer, body.sources);
        answer.classList.remove('pending');
        return { ...body, question };
      } catch (err) {
        answer.textContent = err.message || 'Elarion could not answer.';
        answer.classList.remove('pending');
        answer.classList.add('error');
        return null;
      } finally {
        output.scrollTop = output.scrollHeight;
        button.disabled = false;
      }
    };

    // Ctrl/Cmd+Enter submits from either prompt box.
    const bindAskShortcut = (input, button) => input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        button.click();
      }
    });

    cardAskButton.addEventListener('click', async () => {
      const node = focus.node;
      if (!node) return;
      lastCardAnswer = null;
      cardSpawnButton.style.display = 'none';
      const reply = await askElarion({
        button: cardAskButton,
        input: cardAskInput,
        output: cardAskAnswer,
        label: node.title || node.name || '',
        focusId: node.id,
        nodeIds: [node.id, ...[...focus.nodeIds].filter(id => id !== node.id)]
      });
      if (!reply) return;
      // Saved history from the server; if saving failed, keep the answer in memory for this session.
      const research = Array.isArray(reply.research) ? reply.research : [
        ...(Array.isArray(node.research) ? node.research : []),
        { question: reply.question, answer: reply.answer, sources: reply.sources || [], asked_at: new Date().toISOString() }
      ].slice(-RESEARCH_MAX_ENTRIES);
      syncNodeResearch(node, research);
      // Only redraw the card if it still shows this node; the history is stored either way.
      if (!focus.node || focus.node.id !== node.id) return;
      renderResearch(focus.node);
      lastCardAnswer = { node: focus.node, question: reply.question, answer: reply.answer, sources: reply.sources };
      cardSpawnButton.style.display = 'inline-block';
    });

    // Reopening a card re-renders from these objects, so every in-memory copy of the node gets the history.
    const syncNodeResearch = (node, research) => {
      node.research = research;
      [graphData.nodes, Graph.graphData().nodes].forEach(list => list.forEach(item => {
        if (item.id === node.id) item.research = research;
      }));
    };

    cardSpawnButton.addEventListener('click', () => {
      if (!lastCardAnswer) return;
      const { node, ...entry } = lastCardAnswer;
      spawnFromAnswer(node, entry);
    });

    function spawnFromAnswer(node, { question, answer, sources }) {
      const category = getNodeCategory(node);
      openAddNodeModal({
        title: truncate('Research: ' + question.split(NEWLINE).join(' '), 80),
        category: CATEGORY_ORDER.includes(category) ? category : 'note',
        content: truncate(formatAnswer(answer, sources), 5000),
        linkTargetId: node.id
      });
    }

    // The video a card can show in the reader: its own link when that plays inline (YouTube, Vimeo, a video file), else
    // a YouTube or Vimeo player written into its text, as an <iframe src="..."> embed or a plain link.
    // No backslashes: this script sits inside the page's template string, which would eat them.
    const IFRAME_SRC = /<iframe[^>]*src=["']([^"']+)["'][^>]*>(?:[^<]*<[/]iframe>)?/i;
    const VIDEO_LINK = /https?:[/][/](?:www[.]|m[.])?(?:youtube[.]com|youtu[.]be|youtube-nocookie[.]com|vimeo[.]com|player[.]vimeo[.]com)[/][A-Za-z0-9_.~?=&%#:/+-]+/i;
    const readerMediaFor = (node, text) => {
      const spatial = window.AetherSpatial;
      if (!spatial || !spatial.parseMedia) return null;
      const own = node && node.url ? spatial.parseMedia(node.url) : null;
      if (own) return own;
      const embedded = IFRAME_SRC.exec(text || '') || VIDEO_LINK.exec(text || '');
      const media = embedded ? spatial.parseMedia(embedded[1] || embedded[0]) : null;
      return media && media.kind !== 'file' ? media : null;
    };
    // The player for the reader, waiting for a press (the parsed embed URL asks to autoplay).
    const readerVideoElement = (media, title) => {
      const frame = document.createElement('div');
      frame.className = 'reader-video';
      let element;
      if (media.kind === 'file') {
        element = document.createElement('video');
        element.src = media.src;
        element.controls = true;
        element.playsInline = true;
        element.preload = 'metadata';
      } else {
        const src = new URL(media.embedUrl);
        src.searchParams.delete('autoplay');
        element = document.createElement('iframe');
        element.src = src.toString();
        element.title = title || 'Video';
        element.allow = 'encrypted-media; picture-in-picture; fullscreen';
        element.allowFullscreen = true;
        // YouTube's embeds refuse to play without a referrer.
        element.referrerPolicy = 'strict-origin-when-cross-origin';
      }
      frame.append(element);
      return frame;
    };

    // media (optional): a parsed video (readerMediaFor) to play above the text.
    const showReader = (title, meta, body, media = null) => {
      readerTitle.textContent = title;
      readerMeta.textContent = meta;
      readerBody.textContent = body;
      if (media) {
        // One player at a time: the floating one stops when the reader's starts.
        stopMedia();
        readerBody.prepend(readerVideoElement(media, title));
      }
      if (cardLink.getAttribute('href')) {
        readerLink.href = cardLink.href;
        styleLinkAction(readerLink, cardLink.href, false);
        readerLink.style.display = 'inline-flex';
      } else {
        readerLink.removeAttribute('href');
        readerLink.style.display = 'none';
      }
      readerModal.hidden = false;
      readerBody.scrollTop = 0;
      readerClose.focus();
    };
    const openReader = () => {
      const site = cardPreview.style.display === 'none' ? '' : cardSite.textContent;
      const note = cardNote.style.display === 'none' ? '' : cardNoteText.textContent;
      const description = cardDescription.textContent;
      const media = readerMediaFor(focus.node, note + NEWLINE + description);
      // An embed written into the text shows as the player, not as markup.
      const strip = text => media ? text.replace(new RegExp(IFRAME_SRC.source, 'gi'), '').trim() : text;
      showReader(
        cardTitle.textContent,
        [cardTag.textContent, site, cardMeta.textContent].filter(Boolean).join(' · '),
        [note ? '📝 Your note' + NEWLINE + strip(note) : '', strip(description)].filter(Boolean).join(NEWLINE + NEWLINE),
        media
      );
    };
    // Closing empties the reader, which also stops its video.
    const closeReader = () => {
      readerModal.hidden = true;
      readerBody.replaceChildren();
    };
    cardReaderButton.addEventListener('click', openReader);

    // YouTube Transcript Pipeline. The graph carries each video's synopsis and whether a transcript is stored;
    // the transcript text is only downloaded (and then kept here) when someone opens it.
    const transcriptTexts = new Map();
    const transcriptBusy = new Set();

    function renderCardTranscript(node) {
      const isVideo = getPlatform(node) === 'youtube';
      cardTranscript.hidden = !isVideo;
      if (!isVideo) return;
      const busy = transcriptBusy.has(node.id);
      const hasResult = Boolean(node.synopsis || node.has_transcript);
      cardSynopsis.textContent = node.synopsis || '';
      cardTranscriptButton.disabled = busy;
      cardTranscriptButton.textContent = busy ? '⏳ Fetching…' : hasResult ? '↻ Refresh' : '🎬 Get Transcript';
      cardTranscriptButton.title = hasResult ? 'Fetch the captions and synopsis again' : 'Fetch the captions and write a synopsis with Gemini';
      cardTranscriptRead.hidden = !node.has_transcript;
      cardTranscriptStatus.classList.remove('error');
      cardTranscriptStatus.textContent = busy
        ? 'This can take up to a minute.'
        : hasResult && !node.has_transcript ? 'No captions; synopsis written from the video.' : '';
    }

    const isCardFor = node => Boolean(focus.node && focus.node.id === node.id && nodeCard.style.display === 'block');

    const showTranscriptError = (node, message) => {
      if (!isCardFor(node)) return;
      cardTranscriptStatus.textContent = message;
      cardTranscriptStatus.classList.add('error');
    };

    // Results land on the node object, so they show again whenever its card reopens.
    const fetchTranscript = async node => {
      if (transcriptBusy.has(node.id)) return;
      const refresh = Boolean(node.synopsis || node.has_transcript);
      transcriptBusy.add(node.id);
      renderCardTranscript(node);
      try {
        const result = await apiFetch('/api/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: node.id, refresh })
        });
        node.synopsis = result.synopsis || null;
        node.has_transcript = Boolean(result.transcript);
        if (result.transcript) transcriptTexts.set(node.id, result.transcript);
        transcriptBusy.delete(node.id);
        if (isCardFor(node)) renderCardTranscript(node);
      } catch (err) {
        console.error('Transcript failed:', err);
        transcriptBusy.delete(node.id);
        if (isCardFor(node)) renderCardTranscript(node);
        showTranscriptError(node, err.message || 'Could not get the transcript.');
      }
    };

    const openTranscript = async node => {
      let text = transcriptTexts.get(node.id);
      if (!text) {
        cardTranscriptRead.disabled = true;
        try {
          const result = await apiFetch('/api/transcript?id=' + encodeURIComponent(node.id));
          text = result.transcript || '';
          if (text) transcriptTexts.set(node.id, text);
        } catch (err) {
          console.error('Transcript load failed:', err);
          showTranscriptError(node, err.message || 'Could not load the transcript.');
          return;
        } finally {
          cardTranscriptRead.disabled = false;
        }
      }
      if (!text) {
        showTranscriptError(node, 'No transcript is stored for this video.');
        return;
      }
      // The card may have moved on while the text loaded.
      if (isCardFor(node)) showReader('Transcript: ' + (node.title || node.name || 'Video'), 'YouTube transcript', text);
    };

    // Web Content Fetcher for ordinary links (YouTube has the transcript instead). Like transcripts, the text is
    // only downloaded when someone asks for it, then kept for the session.
    const webTexts = new Map();
    const webBusy = new Set();
    // Platforms other than 'notes', 'images' and 'youtube' are all http(s) links.
    const isWebLink = node => ['links', 'x', 'facebook'].includes(getPlatform(node));

    function renderCardWeb(node) {
      const show = isWebLink(node);
      cardWeb.hidden = !show;
      if (!show) return;
      const busy = webBusy.has(node.id);
      cardWebButton.disabled = busy;
      cardWebButton.textContent = busy ? '⏳ Fetching…' : node.has_content ? '↻ Fetch Again' : '🌐 Fetch Web Content';
      cardWebRead.hidden = !node.has_content;
      cardWebStatus.classList.remove('error');
      cardWebStatus.textContent = busy ? 'Reading the page…' : '';
    }

    const showWebContent = (node, text) => {
      const site = node.site_name || getHostname(String(node.url || ''));
      showReader('Web content: ' + (node.title || node.name || site || 'Link'), site, text);
    };

    const showWebError = (node, message) => {
      if (!isCardFor(node)) return;
      cardWebStatus.textContent = message;
      cardWebStatus.classList.add('error');
    };

    const fetchWeb = async node => {
      if (webBusy.has(node.id)) return;
      webBusy.add(node.id);
      renderCardWeb(node);
      try {
        const result = await apiFetch('/api/web-fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: node.id })
        });
        node.has_content = true;
        webTexts.set(node.id, result.content);
        webBusy.delete(node.id);
        if (!isCardFor(node)) return;
        renderCardWeb(node);
        showWebContent(node, result.content);
      } catch (err) {
        console.error('Web fetch failed:', err);
        webBusy.delete(node.id);
        if (isCardFor(node)) renderCardWeb(node);
        showWebError(node, err.message || 'Could not fetch the page.');
      }
    };

    const openWeb = async node => {
      let text = webTexts.get(node.id);
      if (!text) {
        cardWebRead.disabled = true;
        try {
          const result = await apiFetch('/api/web-fetch?id=' + encodeURIComponent(node.id));
          text = result.content || '';
          if (text) webTexts.set(node.id, text);
        } catch (err) {
          console.error('Web content load failed:', err);
          showWebError(node, err.message || 'Could not load the page text.');
          return;
        } finally {
          cardWebRead.disabled = false;
        }
      }
      if (!text) {
        showWebError(node, 'No page text is stored for this link.');
        return;
      }
      if (isCardFor(node)) showWebContent(node, text);
    };

    cardWebButton.addEventListener('click', () => {
      if (focus.node) fetchWeb(focus.node);
    });
    cardWebRead.addEventListener('click', () => {
      if (focus.node) openWeb(focus.node);
    });

    cardTranscriptButton.addEventListener('click', () => {
      if (focus.node) fetchTranscript(focus.node);
    });
    cardTranscriptRead.addEventListener('click', () => {
      if (focus.node) openTranscript(focus.node);
    });

    const telegramHelpModal = document.getElementById('telegram-help-modal');
    const telegramHelpButton = document.getElementById('telegram-help-button');
    const closeTelegramHelp = () => {
      telegramHelpModal.hidden = true;
      telegramHelpButton.focus();
    };
    const openTelegramHelp = () => {
      filterMenu.open = false;
      settingsMenu.classList.remove('open');
      telegramHelpModal.hidden = false;
      document.getElementById('telegram-help-close').focus();
    };
    telegramHelpButton.addEventListener('click', openTelegramHelp);
    document.getElementById('telegram-help-menu-option').addEventListener('click', openTelegramHelp);
    document.getElementById('telegram-help-close').addEventListener('click', closeTelegramHelp);
    telegramHelpModal.addEventListener('click', event => { if (event.target === telegramHelpModal) closeTelegramHelp(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !telegramHelpModal.hidden) closeTelegramHelp();
    });
    readerClose.addEventListener('click', closeReader);
    readerModal.addEventListener('click', event => { if (event.target === readerModal) closeReader(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !readerModal.hidden) closeReader();
    });
    bindAskShortcut(cardAskInput, cardAskButton);

    drawerAskButton.addEventListener('click', () => {
      if (!drawerCluster) return;
      askElarion({
        button: drawerAskButton,
        input: drawerAskInput,
        output: drawerAskAnswer,
        label: getClusterLabel(drawerCluster),
        focusId: null,
        nodeIds: getClusterNodes(drawerCluster).map(node => node.id)
      });
    });
    bindAskShortcut(drawerAskInput, drawerAskButton);

    document.getElementById('drawer-close').addEventListener('click', closeClusterDrawer);
    // Phones: the group list's title opens and closes the full sheet over the tab.
    clusterDrawer.querySelector('.drawer-head').addEventListener('click', () => {
      if (phoneBar.matches) clusterDrawer.classList.toggle('expanded');
    });

    cardDelete.addEventListener('click', async () => {
      const node = focus.node;
      if (!node) return;
      const title = node.title || node.name || 'this node';
      if (!window.confirm('Delete "' + truncate(String(title), 80) + '"? This cannot be undone.')) return;
      cardDelete.disabled = true;
      try {
        await apiFetch('/api/node/' + encodeURIComponent(node.id), { method: 'DELETE' });
        if (hover.id === node.id) setHover(null);
        graphData.nodes = graphData.nodes.filter(item => item.id !== node.id);
        graphData.links = graphData.links.filter(link => linkEndId(link.source) !== node.id && linkEndId(link.target) !== node.id);
        hideNodeCard();
        applyGraphFilters();
      } catch (err) {
        console.error('Delete failed:', err);
        alert(err.message || 'Delete failed.');
      } finally {
        cardDelete.disabled = false;
      }
    });

    const addNodeModal = document.getElementById('add-node-modal');
    const addNodeForm = document.getElementById('add-node-form');
    const addNodeTitle = document.getElementById('add-node-title');
    const addNodeCategory = document.getElementById('add-node-category');
    const addNodeContent = document.getElementById('add-node-content');
    const addNodeLink = document.getElementById('add-node-link');
    const addNodeError = document.getElementById('add-node-error');
    const addNodeSubmit = document.getElementById('add-node-submit');
    const categoryLabel = category => category.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    addNodeCategory.replaceChildren(...CATEGORY_ORDER.map(category => new Option(categoryLabel(category), category)));

    // prefill (optional): { title, category, content, linkTargetId }, used by "+ Create Node from Answer".
    const openAddNodeModal = (prefill = {}) => {
      addNodeForm.reset();
      addNodeCategory.value = prefill.category || 'note';
      addNodeTitle.value = prefill.title || '';
      addNodeContent.value = prefill.content || '';
      addNodeError.textContent = '';
      const sorted = [...graphData.nodes].sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      addNodeLink.replaceChildren(
        new Option('— None —', ''),
        ...sorted.map(node => new Option(truncate(String(node.title || node.name || node.id), 60), node.id))
      );
      // Connecting to the node being looked at is the likely intent.
      if (prefill.linkTargetId) addNodeLink.value = prefill.linkTargetId;
      else if (focus.node) addNodeLink.value = focus.node.id;
      filterMenu.open = false;
      settingsMenu.classList.remove('open');
      addNodeModal.hidden = false;
      addNodeTitle.focus();
    };
    const closeAddNodeModal = () => { addNodeModal.hidden = true; };

    document.getElementById('add-node-button').addEventListener('click', () => openAddNodeModal());
    document.getElementById('add-node-cancel').addEventListener('click', closeAddNodeModal);
    addNodeModal.addEventListener('click', event => { if (event.target === addNodeModal) closeAddNodeModal(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !addNodeModal.hidden) closeAddNodeModal();
    });

    // New nodes start next to their link target (or the camera's look-at point) instead of the origin.
    const seedNodePosition = (node, target) => {
      const hasTarget = target && [target.x, target.y, target.z].every(Number.isFinite);
      const anchor = hasTarget ? target : Graph.controls().target;
      const jitter = () => (Math.random() - 0.5) * 30;
      node.x = anchor.x + jitter();
      node.y = anchor.y + jitter();
      node.z = anchor.z + jitter();
    };

    addNodeForm.addEventListener('submit', async event => {
      event.preventDefault();
      const title = addNodeTitle.value.trim();
      if (!title) {
        addNodeTitle.focus();
        return;
      }
      const linkTargetId = addNodeLink.value || null;
      addNodeSubmit.disabled = true;
      addNodeSubmit.textContent = 'Creating…';
      addNodeError.textContent = '';
      try {
        const body = await apiFetch('/api/node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, category: addNodeCategory.value, content: addNodeContent.value.trim(), linkTargetId })
        });
        const node = safeGraphNode(body.node);
        const target = linkTargetId ? Graph.graphData().nodes.find(item => item.id === linkTargetId) : null;
        seedNodePosition(node, target);
        graphData.nodes.push(node);
        if (body.link) graphData.links.push(body.link);

        applyGraphFilters();
        // Active filters (type, time, search, Hide Unlinked) may hide the new node; clear them so it shows.
        if (!Graph.graphData().nodes.some(item => item.id === node.id)) resetFilters();
        closeAddNodeModal();
        focusNewNode(node.id);
      } catch (err) {
        console.error('Create failed:', err);
        addNodeError.textContent = err.message || 'Create failed.';
      } finally {
        addNodeSubmit.disabled = false;
        addNodeSubmit.textContent = 'Create Node';
      }
    });

    // ---- Link to… (the node card): connect the open node to another, chosen from the list or by tapping its card ----
    const linkNodeModal = document.getElementById('link-node-modal');
    const linkNodeForm = document.getElementById('link-node-form');
    const linkNodeSource = document.getElementById('link-node-source');
    const linkNodeTarget = document.getElementById('link-node-target');
    const linkNodeRelation = document.getElementById('link-node-relation');
    const linkNodeError = document.getElementById('link-node-error');
    const linkNodeSubmit = document.getElementById('link-node-submit');
    const linkPickHint = document.getElementById('link-pick-hint');
    const linkPickText = document.getElementById('link-pick-text');
    const nodeLabel = (node, max) => truncate(String(node.title || node.name || node.id), max);
    // The node being linked, while the modal is open.
    let linkSource = null;

    const openLinkModal = (source, prefill = {}) => {
      linkSource = source;
      linkNodeForm.reset();
      linkNodeError.textContent = '';
      linkNodeSource.textContent = 'From: ' + nodeLabel(source, 80);
      const sorted = graphData.nodes.filter(node => node.id !== source.id).sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      linkNodeTarget.replaceChildren(new Option('— Choose a node —', ''), ...sorted.map(node => new Option(nodeLabel(node, 60), node.id)));
      if (prefill.targetId) linkNodeTarget.value = prefill.targetId;
      linkNodeRelation.value = prefill.relation || '';
      filterMenu.open = false;
      settingsMenu.classList.remove('open');
      linkNodeModal.hidden = false;
      (prefill.targetId ? linkNodeRelation : linkNodeTarget).focus();
    };
    const closeLinkModal = () => {
      linkNodeModal.hidden = true;
      linkSource = null;
    };
    const endLinkPick = () => {
      linkPick = null;
      linkPickHint.hidden = true;
    };
    const pickLinkTarget = node => {
      const pick = linkPick;
      if (node.id === pick.source.id) return;
      endLinkPick();
      openLinkModal(pick.source, { targetId: node.id, relation: pick.relation });
    };

    document.getElementById('card-link-button').addEventListener('click', () => {
      if (focus.node) openLinkModal(focus.node);
    });
    document.getElementById('link-node-cancel').addEventListener('click', closeLinkModal);
    linkNodeModal.addEventListener('click', event => { if (event.target === linkNodeModal) closeLinkModal(); });
    // Pick on graph: the card steps aside so the graph is free to tap; Cancel (or Escape) drops the pick.
    document.getElementById('link-node-pick').addEventListener('click', () => {
      linkPick = { source: linkSource, relation: linkNodeRelation.value };
      closeLinkModal();
      hideNodeCard();
      linkPickText.textContent = 'Tap the card to link to “' + nodeLabel(linkPick.source, 40) + '”';
      linkPickHint.hidden = false;
    });
    document.getElementById('link-pick-cancel').addEventListener('click', endLinkPick);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!linkNodeModal.hidden) closeLinkModal();
      else if (linkPick) endLinkPick();
    });

    linkNodeForm.addEventListener('submit', async event => {
      event.preventDefault();
      const source = linkSource;
      const targetId = linkNodeTarget.value;
      if (!source || !targetId) {
        linkNodeTarget.focus();
        return;
      }
      linkNodeSubmit.disabled = true;
      linkNodeSubmit.textContent = 'Linking…';
      linkNodeError.textContent = '';
      try {
        const body = await apiFetch('/api/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: source.id, target: targetId, relationship: linkNodeRelation.value.trim() })
        });
        // One link per pair, as /api/graph draws it: a pair already wired (tags, concepts) takes on the user's relation.
        const link = body.link;
        const pair = [link.source, link.target].sort().join('|');
        const existing = graphData.links.find(item => [linkEndId(item.source), linkEndId(item.target)].sort().join('|') === pair);
        if (existing) Object.assign(existing, { value: link.value, type: link.type, relation: link.relation, depth: link.depth, confidence: link.confidence, stored: true });
        else graphData.links.push(link);
        closeLinkModal();
        applyGraphFilters();
        // The source's card comes back (it stepped aside for a pick) with its cluster rebuilt around the new wire.
        if (focus.node && focus.node.id === source.id) selectNode(source);
        else focusCard(source);
        syncThumbWheel();
      } catch (err) {
        console.error('Link failed:', err);
        linkNodeError.textContent = err.message || 'Link failed.';
      } finally {
        linkNodeSubmit.disabled = false;
        linkNodeSubmit.textContent = 'Link';
      }
    });

    // ---- Connections (the node card): the node's stored links (mined, manual or tutorial), each relabelled or deleted in
    // place. Computed links (shared keywords, categories, tags) are left out: they are rebuilt on every load. ----
    const pairKeyOf = (a, b) => [String(a), String(b)].sort().join('|');
    const storedLinksOf = node => graphData.links.filter(link => link.stored && (linkEndId(link.source) === node.id || linkEndId(link.target) === node.id));
    const setLinksStatus = (message, isError = false) => {
      const status = document.getElementById('card-links-status');
      status.textContent = message;
      status.classList.toggle('error', isError);
    };
    // A function declaration, so showNodeCard can call it whenever a card opens.
    function renderCardLinks(node) {
      const box = document.getElementById('card-links');
      const list = document.getElementById('card-links-list');
      const byId = new Map(graphData.nodes.map(item => [item.id, item]));
      const rows = storedLinksOf(node).map(link => {
        const otherId = linkEndId(link.source) === node.id ? linkEndId(link.target) : linkEndId(link.source);
        return { link, other: byId.get(otherId) };
      }).filter(row => row.other).sort((a, b) => String(a.other.title || '').localeCompare(String(b.other.title || '')));
      box.hidden = rows.length === 0;
      setLinksStatus('');
      list.replaceChildren(...rows.map(({ link, other }) => {
        const item = document.createElement('li');
        item.className = 'card-link-row';
        const target = document.createElement('button');
        target.type = 'button';
        target.className = 'card-link-target';
        target.textContent = nodeLabel(other, 60);
        target.title = 'Open ' + String(other.title || other.name || '');
        target.addEventListener('click', () => focusCard(other));
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 80;
        input.value = link.relation || '';
        input.placeholder = 'relationship';
        input.setAttribute('aria-label', 'Relationship to ' + String(other.title || other.name || ''));
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'card-link-save';
        save.textContent = 'Save';
        save.disabled = true;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'card-link-delete';
        remove.textContent = '×';
        remove.title = 'Delete this link';
        remove.setAttribute('aria-label', 'Delete link to ' + String(other.title || other.name || ''));
        input.addEventListener('input', () => { save.disabled = !input.value.trim() || input.value.trim() === (link.relation || ''); });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !save.disabled) {
            event.preventDefault();
            save.click();
          }
        });
        save.addEventListener('click', () => relabelLink(node, link, other, input.value.trim(), save));
        remove.addEventListener('click', () => removeLink(node, link, other, remove));
        item.append(target, input, save, remove);
        return item;
      }));
    }
    const relabelLink = async (node, link, other, relation, button) => {
      button.disabled = true;
      setLinksStatus('Saving…');
      try {
        const body = await apiFetch('/api/link', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: node.id, target: other.id, relationship: relation })
        });
        link.relation = body.relation;
        if (isCardFor(node)) {
          renderCardLinks(node);
          setLinksStatus('Saved.');
        }
      } catch (err) {
        console.error('Relabel failed:', err);
        button.disabled = false;
        setLinksStatus(err.message || 'Save failed.', true);
      }
    };
    const removeLink = async (node, link, other, button) => {
      if (!window.confirm('Delete the link to "' + nodeLabel(other, 80) + '"?')) return;
      button.disabled = true;
      setLinksStatus('Deleting…');
      try {
        await apiFetch('/api/link', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: node.id, target: other.id })
        });
        const pair = pairKeyOf(node.id, other.id);
        graphData.links = graphData.links.filter(item => !(item.stored && pairKeyOf(linkEndId(item.source), linkEndId(item.target)) === pair));
        applyGraphFilters();
        // The card stays on the node, with its cluster (and the wheel's Card ring) rebuilt without the wire.
        if (isCardFor(node)) {
          selectNode(node);
          setLinksStatus('Link deleted.');
        }
        syncThumbWheel();
      } catch (err) {
        console.error('Link delete failed:', err);
        button.disabled = false;
        setLinksStatus(err.message || 'Delete failed.', true);
      }
    };

    // Pages through an admin batch endpoint (POST ?cursor=N) until it reports done.
    // finish(updated, processed, bodies), when given, runs after the graph reloads; returning true skips the summary alert.
    const runAdminBatches = async ({ button, path, busyLabel, summarize, finish }) => {
      const token = getAdminToken();
      if (!token) return;

      const idleLabel = button.textContent;
      button.disabled = true;
      let processed = 0;
      let updated = 0;
      let cursor = 0;
      const bodies = [];
      try {
        while (true) {
          button.textContent = busyLabel + ' (' + processed + ')';
          const res = await fetch(path + '?cursor=' + encodeURIComponent(cursor), {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token }
          });
          if (res.status === 401) {
            localStorage.removeItem(ADMIN_TOKEN_KEY);
            throw new Error('Admin token rejected.');
          }
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || ('Request failed: ' + res.status));
          bodies.push(body);
          processed += body.processed || 0;
          updated += body.updated || 0;
          if (body.done || body.nextCursor === cursor) break;
          cursor = body.nextCursor;
        }
        await loadGraph();
        settingsMenu.classList.remove('open');
        if (!(finish && finish(updated, processed, bodies))) alert(summarize(updated, processed));
      } catch (err) {
        console.error(path + ' failed:', err);
        alert(err.message || 'Request failed.');
      } finally {
        button.disabled = false;
        button.textContent = idleLabel;
        settingsMenu.classList.remove('open');
      }
    };

    const reclusterButton = document.getElementById('recluster-button');
    reclusterButton.addEventListener('click', () => runAdminBatches({
      button: reclusterButton,
      path: '/api/recluster',
      busyLabel: '🧠 Gemini is organizing nodes...',
      summarize: (updated, processed) => 'Reclustered ' + updated + ' of ' + processed + ' nodes with Gemini AI.'
    }));

    const backfillButton = document.getElementById('backfill-button');
    backfillButton.addEventListener('click', () => runAdminBatches({
      button: backfillButton,
      path: '/api/backfill-metadata',
      busyLabel: '🔗 Fetching link titles...',
      summarize: (updated, processed) => 'Fetched titles for ' + updated + ' of ' + processed + ' links.'
    }));

    const synthesizeButton = document.getElementById('synthesize-button');
    synthesizeButton.addEventListener('click', () => runAdminBatches({
      button: synthesizeButton,
      path: '/api/synthesize',
      busyLabel: '✦ Elarion is looking for patterns...',
      summarize: (created, users) => created
        ? 'Elarion proposed ' + created + (created === 1 ? ' Outcome' : ' Outcomes') + '. Look for the gold cards.'
        : 'No new Outcome this time: no new cross-topic pattern was strong enough.',
      // Fly straight into the gallery of the newest Outcome instead of leaving the camera on the wide view.
      finish: (created, users, bodies) => {
        const ids = [];
        bodies.forEach(body => (body.report || []).forEach(result => ids.push(...(result.ids || []))));
        // The run covers every user; only this user's Outcomes are in the loaded graph.
        const own = ids.filter(id => graphData.nodes.some(item => item.id === id));
        if (!own.length) return false;
        const id = own[own.length - 1];
        // Active filters (type, search, Hide Unlinked) may hide it; clear them so it shows.
        if (!Graph.graphData().nodes.some(item => item.id === id)) resetFilters();
        focusNewNode(id, 6000);
        return true;
      }
    }));

    const remineButton = document.getElementById('remine-button');
    remineButton.addEventListener('click', () => runAdminBatches({
      button: remineButton,
      path: '/api/remine',
      busyLabel: '🏷️ Mining tags & groups...',
      summarize: (updated, processed) => 'Tagged ' + updated + ' of ' + processed + ' nodes and suggested groups.'
    }));

    // ---- View modes: Graph (canvas), List/Grid and Timeline share the filters and the node card ----
    const DAY_MS = 24 * 60 * 60 * 1000;

    const getNodeTime = node => {
      const time = node.created_at ? new Date(node.created_at).getTime() : NaN;
      return Number.isNaN(time) ? null : time;
    };

    // Undated nodes always sort last; direction 1 is newest first, -1 oldest first.
    const compareByTime = (a, b, direction) => {
      const ta = getNodeTime(a);
      const tb = getNodeTime(b);
      if (ta === null || tb === null) return (ta === null) - (tb === null);
      return direction * (tb - ta);
    };

    const categoryRank = node => {
      const index = CATEGORY_ORDER.indexOf(getNodeCategory(node));
      return index === -1 ? CATEGORY_ORDER.length : index;
    };

    const sortNodes = (nodes, sort) => nodes.slice().sort((a, b) => {
      if (sort === 'oldest') return compareByTime(a, b, -1);
      if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
      if (sort === 'category') return (categoryRank(a) - categoryRank(b)) || compareByTime(a, b, 1);
      return compareByTime(a, b, 1);
    });

    const formatItemDate = (node, mode) => {
      const time = getNodeTime(node);
      if (time === null) return '';
      const date = new Date(time);
      if (mode === 'time') return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (mode === 'weekday') return date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      const sameYear = date.getFullYear() === new Date().getFullYear();
      return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    };

    const PREVIEW_CHARS = { list: 160, grid: 110, timeline: 140, board: 90, carousel: 480 };

    // One card for list, grid, timeline, board and carousel; a click opens the regular node card.
    const buildItemCard = (node, variant, dateMode) => {
      const isLink = Boolean(node.url && /^https?:/i.test(node.url));
      const card = document.createElement('article');
      card.className = 'item-card ' + variant;
      card.dataset.id = node.id;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.classList.toggle('active', Boolean(focus.node && focus.node.id === node.id));

      const category = getNodeCategory(node);
      const color = getCategoryColor(category);
      const favicon = isLink ? getFaviconUrl(node) : null;
      const hasImage = isImageSrc(node.image_url);

      if (variant === 'grid' || variant === 'carousel') {
        const cover = document.createElement('div');
        cover.className = 'item-cover';
        // Hex colors get a translucent alpha suffix for the placeholder glow.
        cover.style.setProperty('--chip-soft', /^#[0-9a-f]{6}$/i.test(color) ? color + '55' : 'rgba(0,255,204,0.2)');
        const showPlaceholder = () => {
          cover.replaceChildren();
          cover.classList.add('placeholder');
          cover.textContent = getTypeIcon(category);
          if (isLink) {
            const host = document.createElement('span');
            host.className = 'item-cover-host';
            if (favicon) host.append(buildFavicon(favicon));
            host.append(document.createTextNode(node.site_name || getHostname(node.url)));
            cover.append(host);
          }
        };
        if (hasImage) {
          const img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.src = node.image_url;
          img.addEventListener('error', showPlaceholder);
          cover.append(img);
          if (category === 'video') {
            const play = document.createElement('span');
            play.className = 'item-play';
            play.textContent = '▶';
            cover.append(play);
          }
        } else {
          showPlaceholder();
        }
        card.append(cover);
      } else if (variant === 'list' && hasImage) {
        const thumb = document.createElement('img');
        thumb.className = 'item-thumb';
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.referrerPolicy = 'no-referrer';
        thumb.src = node.image_url;
        thumb.addEventListener('error', () => {
          thumb.remove();
          card.classList.remove('has-thumb');
        });
        card.classList.add('has-thumb');
        card.append(thumb);
      }

      const head = document.createElement('div');
      head.className = 'item-head';
      const chip = document.createElement('span');
      chip.className = 'item-chip';
      chip.textContent = getTypeIcon(category) + ' ' + formatCategory(category);
      chip.style.setProperty('--chip', color);
      const date = document.createElement('span');
      date.className = 'item-date';
      date.textContent = formatItemDate(node, dateMode || 'date');
      const picker = makeGroupPicker(node);
      head.append(...(picker ? [chip, picker.element, date] : [chip, date]));

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = node.title || node.name || 'Saved Entry';
      card.append(head, title);

      if (node.user_note) {
        const noteLine = document.createElement('div');
        noteLine.className = 'item-note';
        noteLine.textContent = '📝 ' + truncate(String(node.user_note).split(NEWLINE).join(' '), PREVIEW_CHARS[variant] || 140);
        card.append(noteLine);
      }

      const text = getFullText(node, isLink);
      if (text) {
        const preview = document.createElement('div');
        preview.className = 'item-preview';
        preview.textContent = truncate(text.split(NEWLINE).join(' '), PREVIEW_CHARS[variant] || 140);
        card.append(preview);
      }

      if (isLink) {
        const foot = document.createElement('div');
        foot.className = 'item-foot';
        const site = document.createElement('span');
        site.className = 'item-site';
        site.textContent = node.site_name || getHostname(node.url);
        if (favicon) foot.append(buildFavicon(favicon));
        foot.append(site, buildLinkAction(node));
        card.append(foot);
      }

      card.addEventListener('click', () => selectNode(node));
      card.addEventListener('keydown', event => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        selectNode(node);
      });
      return card;
    };

    // Today / Yesterday / Last 7 Days, then one bucket per calendar month; undated nodes go last.
    const getTimelineBucket = (time, startOfToday) => {
      if (time === null) return { key: 'undated', label: 'Undated', dateMode: 'date' };
      if (time >= startOfToday) return { key: 'today', label: 'Today', dateMode: 'time' };
      if (time >= startOfToday - DAY_MS) return { key: 'yesterday', label: 'Yesterday', dateMode: 'time' };
      if (time >= startOfToday - 6 * DAY_MS) return { key: 'week', label: 'Last 7 Days', dateMode: 'weekday' };
      const date = new Date(time);
      return {
        key: 'month-' + date.getFullYear() + '-' + date.getMonth(),
        label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        dateMode: 'date'
      };
    };

    const buildTimeline = nodes => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const timeline = document.createElement('div');
      timeline.className = 'timeline';
      let bucketKey = null;
      let items = null;
      sortNodes(nodes, 'newest').forEach(node => {
        const bucket = getTimelineBucket(getNodeTime(node), startOfToday.getTime());
        if (bucket.key !== bucketKey) {
          bucketKey = bucket.key;
          const section = document.createElement('section');
          section.className = 'timeline-section';
          const heading = document.createElement('h4');
          heading.textContent = bucket.label;
          items = document.createElement('ol');
          items.className = 'timeline-items';
          section.append(heading, items);
          timeline.append(section);
        }
        const row = document.createElement('li');
        row.style.setProperty('--dot', getCategoryColor(getNodeCategory(node)));
        row.append(buildItemCard(node, 'timeline', bucket.dateMode));
        items.append(row);
      });
      return timeline;
    };

    // Board drag and drop runs on pointer events, so mouse, pen and touch share one path. A mouse drag starts
    // after a few pixels of movement; touch waits for a long press, so a normal swipe still scrolls the board.
    const DRAG_START_PX = 6;
    const TOUCH_SLOP_PX = 10;
    const LONG_PRESS_MS = 350;
    const DRAG_EDGE_PX = 48;
    const DRAG_SCROLL_STEP = 14;
    const boardDrag = { node: null, card: null, ghost: null, pointerId: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0, active: false, timer: null, target: null, suppressUntil: 0 };

    const setBoardDropTarget = column => {
      if (boardDrag.target === column) return;
      if (boardDrag.target) boardDrag.target.classList.remove('drop-target');
      boardDrag.target = column;
      if (column) column.classList.add('drop-target');
    };

    // The visible column nearest the pointer horizontally, so drops below a short column, in the gaps or at
    // the screen edge still land; nothing above the board.
    const findBoardColumn = (x, y) => {
      const board = collectionItems.querySelector('.board-view');
      if (!board) return null;
      const area = board.getBoundingClientRect();
      if (y < area.top) return null;
      let best = null;
      let bestDistance = Infinity;
      board.querySelectorAll('.board-column').forEach(column => {
        const rect = column.getBoundingClientRect();
        const left = Math.max(rect.left, area.left);
        const right = Math.min(rect.right, area.right);
        if (right <= left) return;
        const distance = x < left ? left - x : x > right ? x - right : 0;
        if (distance < bestDistance) {
          best = column;
          bestDistance = distance;
        }
      });
      return best;
    };

    const moveBoardGhost = (x, y) => {
      boardDrag.ghost.style.transform = 'translate(' + (x - boardDrag.offsetX) + 'px, ' + (y - boardDrag.offsetY) + 'px) rotate(2deg)';
      // Near an edge, scroll the board sideways (phones) or the view up and down.
      const board = collectionItems.querySelector('.board-view');
      if (board) {
        const rect = board.getBoundingClientRect();
        if (x < rect.left + DRAG_EDGE_PX) board.scrollLeft -= DRAG_SCROLL_STEP;
        else if (x > rect.right - DRAG_EDGE_PX) board.scrollLeft += DRAG_SCROLL_STEP;
      }
      const view = collectionView.getBoundingClientRect();
      if (y < view.top + DRAG_EDGE_PX) collectionView.scrollTop -= DRAG_SCROLL_STEP;
      else if (y > view.bottom - DRAG_EDGE_PX) collectionView.scrollTop += DRAG_SCROLL_STEP;
      const column = findBoardColumn(x, y);
      setBoardDropTarget(column && column.dataset.status !== getNodeStatus(boardDrag.node) ? column : null);
    };

    const startBoardDrag = () => {
      const card = boardDrag.card;
      const rect = card.getBoundingClientRect();
      boardDrag.active = true;
      boardDrag.offsetX = boardDrag.startX - rect.left;
      boardDrag.offsetY = boardDrag.startY - rect.top;
      const ghost = card.cloneNode(true);
      ghost.classList.remove('active', 'pressing');
      ghost.classList.add('board-ghost');
      ghost.removeAttribute('tabindex');
      ghost.removeAttribute('role');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.width = rect.width + 'px';
      document.body.append(ghost);
      boardDrag.ghost = ghost;
      card.classList.remove('pressing');
      card.classList.add('drag-source');
      document.body.classList.add('board-dragging');
      try { card.setPointerCapture(boardDrag.pointerId); } catch (err) {}
      moveBoardGhost(boardDrag.startX, boardDrag.startY);
    };

    const endBoardDrag = drop => {
      clearTimeout(boardDrag.timer);
      const { node, card, ghost, active, target } = boardDrag;
      if (card) card.classList.remove('drag-source', 'pressing');
      if (ghost) ghost.remove();
      setBoardDropTarget(null);
      document.body.classList.remove('board-dragging');
      Object.assign(boardDrag, { node: null, card: null, ghost: null, pointerId: null, active: false, timer: null });
      if (!active) return;
      // The click that follows the pointerup must not open the card.
      boardDrag.suppressUntil = Date.now() + 400;
      if (drop && target && node) moveNodeToStatus(node, target.dataset.status);
    };

    const attachBoardDrag = (card, node) => {
      card.addEventListener('pointerdown', event => {
        if (event.button !== 0 || boardDrag.card || event.target.closest('a, button')) return;
        Object.assign(boardDrag, { node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false });
        if (event.pointerType === 'mouse') return;
        card.classList.add('pressing');
        boardDrag.timer = setTimeout(() => {
          if (boardDrag.card === card && !boardDrag.active) startBoardDrag();
        }, LONG_PRESS_MS);
      });
      card.addEventListener('pointermove', event => {
        if (boardDrag.card !== card || event.pointerId !== boardDrag.pointerId) return;
        if (!boardDrag.active) {
          const moved = Math.hypot(event.clientX - boardDrag.startX, event.clientY - boardDrag.startY);
          if (event.pointerType !== 'mouse') {
            // Moving before the long press completes is a swipe: let the board scroll.
            if (moved > TOUCH_SLOP_PX) endBoardDrag(false);
            return;
          }
          if (moved < DRAG_START_PX) return;
          startBoardDrag();
        }
        moveBoardGhost(event.clientX, event.clientY);
      });
      card.addEventListener('pointerup', event => {
        if (boardDrag.card === card && event.pointerId === boardDrag.pointerId) endBoardDrag(true);
      });
      card.addEventListener('pointercancel', () => {
        if (boardDrag.card === card) endBoardDrag(false);
      });
      // Once a touch drag has started, the finger moves the card instead of scrolling the page.
      card.addEventListener('touchmove', event => {
        if (boardDrag.active && boardDrag.card === card) event.preventDefault();
      }, { passive: false });
      card.addEventListener('contextmenu', event => {
        if (boardDrag.card === card) event.preventDefault();
      });
      card.addEventListener('dragstart', event => event.preventDefault());
    };

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && boardDrag.active) endBoardDrag(false);
    });
    // A press released off its card before a drag began (the card only captures the pointer once dragging).
    document.addEventListener('pointerup', () => {
      if (boardDrag.card && !boardDrag.active) endBoardDrag(false);
    });

    const buildBoard = nodes => {
      const board = document.createElement('div');
      board.className = 'board-view';
      const sorted = sortNodes(nodes, filterState.listSort);
      BOARD_COLUMNS.forEach(column => {
        const items = sorted.filter(node => getNodeStatus(node) === column.status);
        const section = document.createElement('section');
        section.className = 'board-column';
        section.dataset.status = column.status;
        section.style.setProperty('--column', column.color);
        section.setAttribute('aria-label', column.label);
        const head = document.createElement('header');
        head.className = 'board-column-head';
        const name = document.createElement('span');
        name.textContent = column.icon + ' ' + column.label;
        const count = document.createElement('span');
        count.className = 'board-count';
        count.textContent = String(items.length);
        head.append(name, count);
        const body = document.createElement('div');
        body.className = 'board-column-body';
        if (!items.length) {
          const empty = document.createElement('div');
          empty.className = 'board-empty';
          empty.textContent = 'Drop cards here';
          body.append(empty);
        }
        items.forEach(node => {
          const card = buildItemCard(node, 'board');
          attachBoardDrag(card, node);
          body.append(card);
        });
        section.append(head, body);
        board.append(section);
      });
      board.addEventListener('click', event => {
        if (Date.now() < boardDrag.suppressUntil) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
      return board;
    };

    const renderCardStatus = node => {
      const status = getNodeStatus(node);
      cardStatus.querySelectorAll('[data-status]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.status === status));
      });
    };

    const refreshStatusViews = node => {
      if (filterState.view === 'board') renderCollection();
      if (filterState.flat) layoutBoard();
      if (focus.node && focus.node.id === node.id) renderCardStatus(node);
    };

    // Optimistic: the card moves at once and moves back if the save fails.
    const moveNodeToStatus = async (node, status) => {
      const previous = getNodeStatus(node);
      if (!NODE_STATUSES.includes(status) || status === previous) return;
      node.status = status;
      refreshStatusViews(node);
      try {
        await apiFetch('/api/node/' + encodeURIComponent(node.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
      } catch (err) {
        console.error('Status update failed:', err);
        if (node.status === status) {
          node.status = previous;
          refreshStatusViews(node);
        }
        alert(err.message || 'Could not move the card.');
      }
    };

    BOARD_COLUMNS.forEach(column => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.status = column.status;
      button.style.setProperty('--column', column.color);
      button.setAttribute('aria-pressed', 'false');
      button.textContent = column.icon + ' ' + column.label;
      cardStatus.append(button);
    });
    cardStatus.addEventListener('click', event => {
      const button = event.target.closest('[data-status]');
      if (button && focus.node) moveNodeToStatus(focus.node, button.dataset.status);
    });

    // Carousel view: the visible nodes (in the list sort) on a curved wall, the same 180-degree Horizon arc as the 3D
    // wall: the viewer stands at the arc's centre (the stage's perspective is the arc's radius), the card in front
    // faces them square on, and the cards either side come forward and turn in toward them along the curve, running off
    // the edges of the screen. deck.id is the card in front and survives re-renders and view changes, so the carousel
    // reopens where it was, or on the node selected in the graph.
    // Cards either side kept on the arc (and one more each way, faded out, to slide in while dragging).
    const DECK_SIDE = 3;
    // Slots on the arc per half turn (as on the 3D wall), and the card plus its gap along it.
    const DECK_PER_ARC = 7;
    const DECK_PITCH = 1.08;
    const DECK_FADE_STEP = 0.28;
    const DECK_DRAG_START_PX = 8;
    // A mouse, pen or headset laser pointer jitters and presses deliberately: a drag needs a longer, clearly sideways
    // move, and a flick a longer one, so a click is never read as a tiny drag (which moved the cards under the pointer
    // and swallowed the click on the Quest Browser).
    const DECK_POINTER_DRAG_START_PX = 24;
    const DECK_POINTER_FLICK_PX = 60;
    const DECK_COMMIT_SHARE = 0.25;
    const DECK_FLICK_PX = 30;
    const DECK_FLICK_SPEED = 0.45;
    const DECK_CLICK_GUARD_MS = 400;
    const deck = { nodes: [], index: 0, id: null, cards: new Map(), stage: null, counter: null, prev: null, next: null, radius: 1, step: 0, slidePx: 1, suppressClickUntil: 0 };
    let deckDrag = null;

    // The arc for the stage's size: its radius (px) and the angle between slots. The viewer's distance (the stage's
    // perspective) is the radius, so the card in front is drawn at its own size.
    const measureDeckArc = () => {
      const card = deck.stage.querySelector('.item-card.carousel');
      const width = (card && card.offsetWidth) || Math.min(440, deck.stage.clientWidth * 0.78);
      deck.step = Math.PI / DECK_PER_ARC;
      deck.radius = (width * DECK_PITCH) / deck.step;
      // How far a drag moves the wall by one slot: the next card's centre on screen (a tangent, seen from the centre).
      deck.slidePx = deck.radius * Math.tan(deck.step);
      deck.stage.style.perspective = Math.round(deck.radius) + 'px';
    };
    // position: the card's slot relative to the card in front (0), fractional mid-drag. A card at angle a on the arc
    // stands radius * sin(a) across and radius * (1 - cos(a)) nearer, turned by -a to face the centre.
    const placeDeckCard = (card, position) => {
      const angle = position * deck.step;
      const across = deck.radius * Math.sin(angle);
      const nearer = deck.radius * (1 - Math.cos(angle));
      const distance = Math.abs(position);
      card.style.transform = 'translate3d(' + across.toFixed(1) + 'px, 0, ' + nearer.toFixed(1) + 'px) rotateY(' + (-angle * 180 / Math.PI).toFixed(2) + 'deg)';
      card.style.opacity = String(distance <= DECK_SIDE ? 1 - DECK_FADE_STEP * Math.max(0, distance - 1) : 0);
      card.style.zIndex = String(100 - Math.round(distance * 10));
    };

    const layoutDeck = () => {
      if (!deck.stage || !deck.stage.isConnected) return;
      const wanted = new Map();
      for (let offset = -DECK_SIDE - 1; offset <= DECK_SIDE + 1; offset++) {
        const node = deck.nodes[deck.index + offset];
        if (node) wanted.set(node.id, { node, offset });
      }
      deck.cards.forEach((card, id) => {
        if (wanted.has(id)) return;
        card.remove();
        deck.cards.delete(id);
      });
      wanted.forEach(({ node, offset }, id) => {
        let card = deck.cards.get(id);
        if (!card) {
          card = buildItemCard(node, 'carousel');
          card.querySelectorAll('img').forEach(img => { img.draggable = false; });
          deck.stage.append(card);
          deck.cards.set(id, card);
        }
        card.dataset.offset = String(offset);
        card.classList.toggle('behind', offset !== 0);
        card.classList.toggle('beyond', Math.abs(offset) > DECK_SIDE);
        card.tabIndex = offset === 0 ? 0 : -1;
        card.setAttribute('aria-hidden', String(offset !== 0));
      });
      measureDeckArc();
      deck.cards.forEach(card => placeDeckCard(card, Number(card.dataset.offset)));
      deck.counter.textContent = (deck.index + 1) + ' / ' + deck.nodes.length;
      deck.prev.disabled = deck.index <= 0;
      deck.next.disabled = deck.index >= deck.nodes.length - 1;
    };

    // Mid-drag the whole wall turns with the finger along the arc, one slot per slidePx; past either end it only gives
    // a little.
    const dragDeck = dx => {
      const atEnd = dx < 0 ? deck.index >= deck.nodes.length - 1 : deck.index <= 0;
      const shift = Math.max(-1, Math.min(1, (atEnd ? dx * 0.25 : dx) / deck.slidePx));
      deck.cards.forEach(card => placeDeckCard(card, Number(card.dataset.offset) + shift));
    };

    const setDeckIndex = index => {
      deck.index = index;
      deck.id = deck.nodes[index].id;
      layoutDeck();
    };

    // An open node card follows the deck; selectNode then moves the deck through syncDeck.
    const stepDeck = delta => {
      if (!deck.stage || !deck.stage.isConnected) return;
      const index = deck.index + delta;
      if (index < 0 || index >= deck.nodes.length) {
        layoutDeck();
        return;
      }
      if (focus.node && nodeCard.style.display === 'block') selectNode(deck.nodes[index], { keepCarousel: true });
      else setDeckIndex(index);
    };

    function syncDeck(node) {
      deck.id = node.id;
      if (filterState.view !== 'carousel') return;
      const index = deck.nodes.findIndex(item => item.id === node.id);
      if (index !== -1 && index !== deck.index) setDeckIndex(index);
    }

    const endDeckDrag = (event, cancelled) => {
      if (!deckDrag || event.pointerId !== deckDrag.pointerId) return;
      const drag = deckDrag;
      deckDrag = null;
      cancelAnimationFrame(drag.frame);
      if (!drag.active) return;
      deck.stage.classList.remove('dragging');
      deck.suppressClickUntil = performance.now() + DECK_CLICK_GUARD_MS;
      const flick = Math.abs(drag.dx) > drag.flickPx && Math.abs(drag.speed) > DECK_FLICK_SPEED && Math.sign(drag.speed) === Math.sign(drag.dx);
      if (!cancelled && (flick || Math.abs(drag.dx) > deck.slidePx * DECK_COMMIT_SHARE)) stepDeck(drag.dx < 0 ? 1 : -1);
      else layoutDeck();
    };

    const buildDeck = nodes => {
      deck.nodes = sortNodes(nodes, filterState.listSort);
      const found = deck.nodes.findIndex(node => node.id === deck.id);
      deck.index = found !== -1 ? found : Math.min(deck.index, deck.nodes.length - 1);
      deck.id = deck.nodes[deck.index].id;
      deck.cards = new Map();
      deckDrag = null;

      const view = document.createElement('div');
      view.className = 'deck-view';
      const stage = document.createElement('div');
      stage.className = 'deck-stage';
      stage.setAttribute('role', 'region');
      stage.setAttribute('aria-roledescription', 'carousel');
      stage.setAttribute('aria-label', 'Node cards');

      const controls = document.createElement('div');
      controls.className = 'deck-controls';
      const makeButton = (label, text, delta) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'deck-btn';
        button.setAttribute('aria-label', label);
        button.textContent = text;
        button.addEventListener('click', () => stepDeck(delta));
        return button;
      };
      const prev = makeButton('Previous card', '‹', -1);
      const next = makeButton('Next card', '›', 1);
      const counter = document.createElement('span');
      counter.className = 'deck-counter';
      counter.setAttribute('aria-live', 'polite');
      controls.append(prev, counter, next);
      const hint = document.createElement('div');
      hint.className = 'deck-hint';
      hint.textContent = 'Swipe or tap a side card to turn · tap the front card for details';
      view.append(stage, controls, hint);
      Object.assign(deck, { stage, counter, prev, next });

      // A sideways drag pages the deck; a mostly vertical one is left to the page scroll (touch-action: pan-y).
      stage.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        const touch = event.pointerType === 'touch';
        deckDrag = {
          pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, speed: 0, lastX: event.clientX, lastTime: event.timeStamp, active: false,
          startPx: touch ? DECK_DRAG_START_PX : DECK_POINTER_DRAG_START_PX,
          flickPx: touch ? DECK_FLICK_PX : DECK_POINTER_FLICK_PX,
          frame: 0
        };
      });
      stage.addEventListener('pointermove', event => {
        if (!deckDrag || event.pointerId !== deckDrag.pointerId) return;
        const dx = event.clientX - deckDrag.x;
        const dy = event.clientY - deckDrag.y;
        if (!deckDrag.active) {
          if (Math.abs(dy) > deckDrag.startPx && Math.abs(dy) > Math.abs(dx)) {
            deckDrag = null;
            return;
          }
          if (Math.abs(dx) < deckDrag.startPx || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
          deckDrag.active = true;
          stage.setPointerCapture(event.pointerId);
          stage.classList.add('dragging');
        }
        const elapsed = event.timeStamp - deckDrag.lastTime;
        if (elapsed > 0) deckDrag.speed = (event.clientX - deckDrag.lastX) / elapsed;
        deckDrag.lastX = event.clientX;
        deckDrag.lastTime = event.timeStamp;
        deckDrag.dx = dx;
        // At most one restyle per frame: laser pointers report moves far faster than the display refreshes.
        if (!deckDrag.frame) deckDrag.frame = requestAnimationFrame(() => {
          if (!deckDrag) return;
          deckDrag.frame = 0;
          dragDeck(deckDrag.dx);
        });
      });
      // Capture lost without a pointerup (the browser took the pointer): the drag ends where it is. Only the stage's
      // own capture counts: taking it over from a card (a touch is captured to the card it lands on) makes the card
      // fire lostpointercapture, which bubbles here before the pointerup and cancelled every touch swipe.
      stage.addEventListener('lostpointercapture', event => {
        if (event.target === stage) endDeckDrag(event, true);
      });
      stage.addEventListener('pointerup', event => endDeckDrag(event, false));
      stage.addEventListener('pointercancel', event => endDeckDrag(event, true));
      stage.addEventListener('dragstart', event => event.preventDefault());
      // A drag that ends over the card must not also open it or follow its link; a tap on a card at the side of the
      // arc brings it round to the front instead of opening it.
      stage.addEventListener('click', event => {
        const side = event.target.closest('.item-card.carousel.behind');
        if (performance.now() >= deck.suppressClickUntil && !side) return;
        event.preventDefault();
        event.stopPropagation();
        if (side && performance.now() >= deck.suppressClickUntil) stepDeck(Number(side.dataset.offset));
      }, true);
      return view;
    };

    document.getElementById('card-to-deck').addEventListener('click', () => {
      if (!focus.node) return;
      deck.id = focus.node.id;
      // On phones the card is a bottom sheet over the deck, so it closes; the deck's top card reopens it.
      if (compactLayout.matches) hideNodeCard();
      setView('carousel');
    });
    window.addEventListener('resize', () => {
      if (filterState.view === 'carousel') layoutDeck();
    });

    // The list's scrollbar width, for the control wheel to stand clear of (0 with overlay scrollbars).
    const measureScrollbar = () => {
      if (filterState.view === 'graph') return;
      const width = Math.max(0, collectionView.offsetWidth - collectionView.clientWidth);
      document.documentElement.style.setProperty('--scrollbar-w', width + 'px');
    };
    window.addEventListener('resize', measureScrollbar);
    const renderCollection = () => {
      requestAnimationFrame(measureScrollbar);
      const nodes = currentVisibleNodes.filter(matchesPlatform);
      const isTimeline = filterState.view === 'timeline';
      const isBoard = filterState.view === 'board';
      const isCarousel = filterState.view === 'carousel';
      const isGrid = !isTimeline && !isBoard && !isCarousel && filterState.listLayout === 'grid';
      collectionCount.textContent = nodes.length + (nodes.length === 1 ? ' node' : ' nodes');
      collectionSort.hidden = isTimeline;
      layoutPills.hidden = isTimeline || isBoard || isCarousel;
      collectionSort.value = filterState.listSort;
      layoutPills.querySelectorAll('[data-layout]').forEach(pill => pill.classList.toggle('active', pill.dataset.layout === filterState.listLayout));
      collectionToolbar.classList.toggle('wide', isGrid || isBoard);

      if (!nodes.length) {
        const empty = document.createElement('div');
        empty.className = 'collection-empty';
        const message = document.createElement('div');
        message.textContent = !graphLoaded ? 'Loading nodes…' : graphData.nodes.length ? 'No nodes match these filters.' : 'No nodes yet. Add one with +.';
        empty.append(message);
        if (graphData.nodes.length) {
          const clear = document.createElement('button');
          clear.type = 'button';
          clear.className = 'toggle-button';
          clear.textContent = 'Clear Filters';
          clear.addEventListener('click', resetFilters);
          empty.append(clear);
        }
        collectionItems.replaceChildren(empty);
        return;
      }

      if (isTimeline) {
        collectionItems.replaceChildren(buildTimeline(nodes));
        return;
      }
      if (isBoard) {
        // Re-rendering after a move keeps the phone's sideways scroll position.
        const previous = collectionItems.querySelector('.board-view');
        const scrollLeft = previous ? previous.scrollLeft : 0;
        const board = buildBoard(nodes);
        collectionItems.replaceChildren(board);
        board.scrollLeft = scrollLeft;
        return;
      }
      if (isCarousel) {
        collectionItems.replaceChildren(buildDeck(nodes));
        layoutDeck();
        return;
      }
      const list = document.createElement('div');
      list.className = isGrid ? 'collection-grid' : 'collection-list';
      list.append(...sortNodes(nodes, filterState.listSort).map(node => buildItemCard(node, isGrid ? 'grid' : 'list')));
      collectionItems.replaceChildren(list);
    };

    // The canvas keeps its data up to date in every view, but only animates while it is visible.
    function renderActiveView() {
      syncThumbWheel();
      const isGraph = filterState.view === 'graph';
      document.body.classList.toggle('collection-mode', !isGraph);
      document.body.classList.toggle('board-mode', filterState.view === 'board');
      document.body.classList.toggle('carousel-mode', filterState.view === 'carousel');
      viewSwitch.querySelectorAll('[data-view]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.view === filterState.view));
      });
      if (isGraph) {
        Graph.resumeAnimation();
        return;
      }
      Graph.pauseAnimation();
      closeClusterDrawer();
      if (hover.id) setHover(null);
      renderCollection();
    }

    const setView = view => {
      if (!VIEW_MODES.includes(view) || view === filterState.view) return;
      filterState.view = view;
      // Entering the carousel with a node selected (in the graph or any other view) opens the deck on it.
      if (view === 'carousel' && focus.node) deck.id = focus.node.id;
      saveViewPrefs();
      renderActiveView();
      if (view === 'graph') {
        if (focus.node) setFocus(focus.node);
        wakeLayout();
        scheduleResume();
      } else {
        cancelPendingFit();
        collectionView.scrollTop = 0;
        syncDrawerSelection();
      }
    };

    viewSwitch.addEventListener('click', event => {
      const button = event.target.closest('[data-view]');
      if (button) setView(button.dataset.view);
    });
    collectionSort.addEventListener('change', () => {
      filterState.listSort = LIST_SORTS.includes(collectionSort.value) ? collectionSort.value : 'newest';
      saveViewPrefs();
      renderCollection();
    });
    layoutPills.addEventListener('click', event => {
      const pill = event.target.closest('[data-layout]');
      if (!pill || pill.dataset.layout === filterState.listLayout) return;
      filterState.listLayout = pill.dataset.layout;
      saveViewPrefs();
      renderCollection();
    });
    // Restored view applies before the first graph load, so there is no flash of the wrong view.
    renderActiveView();

    // ---- Control wheel (public/js/spatial/thumb-wheel.js; phones and desktop): View rim outermost (3D Space, List,
    // Timeline, Board, Carousel), then the primary ring (the Scale in 3D Space, the Layout on the Board, Time elsewhere),
    // then what the stop needs (Space: Time; Cluster: Depth; Horizon: Show; Atomic: nothing). The hub is + Add. In the
    // Simple mode only the rim and the primary ring show. ----
    const thumbWheelMount = document.getElementById('thumb-wheel');
    const WHEEL_TIME_LABELS = { day: 'Today', week: 'Week', month: 'Month', groups: 'Groups', all: 'All' };
    const WHEEL_BOARD_LABELS = { groups: 'Groups', status: 'Status', map: 'Map', timeline: 'Timeline' };
    const wheelRingDefs = () => ({
      view: { name: 'View', stops: [
        { value: 'space', label: '3D Space' },
        { value: 'list', label: 'List' },
        { value: 'timeline', label: 'Timeline' },
        { value: 'board', label: 'Board' },
        { value: 'carousel', label: 'Carousel' }
      ] },
      scale: { name: 'Scale', stops: ZOOM_STOP_ORDER.map(value => ({ value, label: ZOOM_STOP_NAMES[value] })) },
      layout: { name: 'Board layout', stops: BOARD_MODES.map(value => ({ value, label: WHEEL_BOARD_LABELS[value] })) },
      time: { name: 'Time', stops: SCOPES.map(value => ({ value, label: WHEEL_TIME_LABELS[value] })) },
      depth: { name: 'Depth', stops: DEPTH_LEVELS.map(value => ({ value, label: DEPTH_LABELS[value] })) },
      filters: { name: 'Show', stops: Object.keys(PLATFORM_LABELS).map(value => ({ value, label: value === 'x' ? 'X' : PLATFORM_LABELS[value] })) }
    });
    // The status Board view (kept for desktop) reads as the wheel's Board, in its Status layout.
    const wheelView = () => filterState.view === 'graph' ? (filterState.flat ? 'board' : 'space') : filterState.view;
    const wheelState = () => ({
      view: wheelView(),
      scale: zoomStop,
      layout: filterState.view === 'board' ? 'status' : filterState.boardMode,
      time: filterState.horizon,
      depth: filterState.depth,
      filters: filterState.platform
    });
    const setWheelView = value => {
      if (value === 'space' || value === 'board') {
        setView('graph');
        setFlat(value === 'board');
      } else {
        setView(value);
      }
    };
    const onWheelChange = (ring, value) => {
      if (ring === 'view') setWheelView(value);
      else if (ring === 'scale') setZoomStop(value);
      else if (ring === 'layout') {
        if (filterState.view !== 'graph' || !filterState.flat) setWheelView('board');
        const button = boardModeButtons.find(item => item.dataset.boardMode === value);
        if (button) button.click();
      } else if (ring === 'time') setScope(value);
      else if (ring === 'depth') setDepth(value);
      else if (ring === 'filters' && value !== filterState.platform) setPlatform(value);
      // A stop that could not be reached (nothing there) turns the ring back to where the view is.
      syncThumbWheel();
    };
    // Where the phone cannot vibrate (iPhone), the wheel can tick audibly; remembered per browser.
    const DIAL_SOUND_KEY = 'aetherDialSound';
    const dialSoundOption = document.getElementById('dial-sound-option');
    const dialSoundOn = () => {
      try {
        return localStorage.getItem(DIAL_SOUND_KEY) !== 'off';
      } catch (err) {
        return true;
      }
    };
    const renderDialSound = () => { dialSoundOption.textContent = (dialSoundOn() ? '🔈 Wheel clicks: On' : '🔇 Wheel clicks: Off'); };
    dialSoundOption.hidden = typeof navigator.vibrate === 'function';
    renderDialSound();
    dialSoundOption.addEventListener('click', () => {
      try { localStorage.setItem(DIAL_SOUND_KEY, dialSoundOn() ? 'off' : 'on'); } catch (err) {}
      renderDialSound();
    });
    // Wheel mode (Simple or Advanced), remembered per browser; the headset barrel's hub switches the same mode.
    const WHEEL_MODE_KEY = 'aetherWheelMode';
    const wheelModeButton = document.getElementById('wheel-mode');
    let wheelMode = 'advanced';
    try {
      if (localStorage.getItem(WHEEL_MODE_KEY) === 'simple') wheelMode = 'simple';
    } catch (err) {}
    const wheelSimple = () => wheelMode === 'simple';
    const renderWheelMode = () => {
      const advanced = !wheelSimple();
      wheelModeButton.setAttribute('aria-checked', String(advanced));
      wheelModeButton.querySelector('.wheel-mode-label').textContent = advanced ? 'Advanced' : 'Simple';
    };
    const setWheelMode = mode => {
      wheelMode = mode === 'simple' ? 'simple' : 'advanced';
      try { localStorage.setItem(WHEEL_MODE_KEY, wheelMode); } catch (err) {}
      renderWheelMode();
      // Open the wheel so the rings are seen telescoping in or out.
      if (thumbWheel) {
        thumbWheel.wake();
        thumbWheel.sync();
      }
    };
    renderWheelMode();
    wheelModeButton.addEventListener('click', event => {
      event.stopPropagation();
      setWheelMode(wheelSimple() ? 'advanced' : 'simple');
    });
    const mountThumbWheel = () => {
      const spatial = window.AetherSpatial;
      if (!spatial || !spatial.createThumbWheel || thumbWheel) return;
      thumbWheel = spatial.createThumbWheel({
        mount: thumbWheelMount,
        rings: wheelRingDefs(),
        state: wheelState,
        onChange: onWheelChange,
        onAdd: () => openAddNodeModal(),
        sound: dialSoundOn,
        simple: wheelSimple
      });
    };
    if (window.AetherSpatial) mountThumbWheel();
    else window.addEventListener('aether-spatial-ready', mountThumbWheel, { once: true });

    const loginGate = document.getElementById('login-gate');
    const loginError = document.getElementById('login-error');

    // Sign-in is Google only: the button goes straight to /api/auth/google (OAuth 2.0 with PKCE), and One Tap
    // offers the signed-in Google account in place when a client id is configured.
    const googleClientId = (document.querySelector('meta[name="google-client-id"]') || {}).content || '';
    const googleSignin = document.getElementById('google-signin');
    const pageParams = new URLSearchParams(window.location.search);
    // Where to go after signing in (the share sheet and /node/<id> links send people here first); same-site paths only.
    // A session that lapses on a /node/<id> page comes back to that node.
    const nextPath = (() => {
      const next = pageParams.get('next') || '';
      if (next.charAt(0) === '/' && next.charAt(1) !== '/' && next.charCodeAt(1) !== 92) return next;
      return deepLinkId ? window.location.pathname : '';
    })();
    googleSignin.href = '/api/auth/google' + (nextPath ? '?next=' + encodeURIComponent(nextPath) : '');

    // Local dev (src/dev-auth.js, DEV_AUTH_BYPASS in .dev.vars): the gate offers the dev operator and signs it in
    // automatically, except right after a sign-out or when the last automatic attempt did not stick.
    const devLoginEnabled = ((document.querySelector('meta[name="aether-dev-login"]') || {}).content || '') === '1';
    const devSignin = document.getElementById('dev-signin');
    devSignin.href = '/api/auth/dev?next=' + encodeURIComponent(nextPath || window.location.pathname + window.location.search);
    const devFlag = (key, value) => {
      try {
        if (value === undefined) return sessionStorage.getItem(key);
        if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
      } catch (err) { return null; }
    };
    devSignin.addEventListener('click', () => devFlag('aether.devSignedOut', null));

    const afterSignIn = async () => {
      if (nextPath) {
        window.location.href = nextPath;
        return;
      }
      loginGate.hidden = true;
      await loadGraph();
    };

    const handleGoogleCredential = async response => {
      loginError.textContent = '';
      try {
        const res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || ('Google sign-in failed: ' + res.status));
        await afterSignIn();
      } catch (err) {
        loginError.textContent = err.message || 'Google sign-in failed.';
      }
    };

    let oneTapRequested = false;
    const startOneTap = () => {
      if (!googleClientId || oneTapRequested) return;
      oneTapRequested = true;
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        const gsi = window.google && window.google.accounts && window.google.accounts.id;
        if (!gsi) return;
        gsi.initialize({ client_id: googleClientId, callback: handleGoogleCredential, auto_select: false, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
        gsi.prompt();
      };
      script.onerror = () => console.warn('Google One Tap could not load; the Sign in with Google button still works.');
      document.head.append(script);
    };

    function showLoginGate() {
      if (!loginGate.hidden) return;
      closeReader();
      closeAddNodeModal();
      settingsMenu.classList.remove('open');
      loginError.textContent = '';
      // A failed Google redirect comes back with ?auth_error=; show it once and tidy the address bar.
      const authError = pageParams.get('auth_error');
      if (authError) {
        loginError.textContent = authError;
        pageParams.delete('auth_error');
        history.replaceState(null, '', window.location.pathname + (pageParams.toString() ? '?' + pageParams.toString() : ''));
      }
      loginGate.hidden = false;
      if (devLoginEnabled) {
        devSignin.hidden = false;
        devSignin.focus();
        const lastTry = Number(devFlag('aether.devAutoLogin') || 0);
        if (!authError && !devFlag('aether.devSignedOut') && Date.now() - lastTry > 10000) {
          devFlag('aether.devAutoLogin', String(Date.now()));
          window.location.href = devSignin.href;
        }
        return;
      }
      googleSignin.focus();
      startOneTap();
    }

    // Preferred name (users.preferred_name): shown in the top bar, Mission Control's greeting and its operator card.
    let preferredName = null;
    function renderUserGreeting(name) {
      preferredName = name || null;
      const el = document.getElementById('user-greeting');
      if (!el) return;
      el.textContent = preferredName ? 'Hi, ' + preferredName : '';
      el.title = preferredName ? 'Signed in as ' + preferredName : '';
      el.hidden = !preferredName;
    }
    document.getElementById('display-name-button').addEventListener('click', async () => {
      const next = window.prompt('Display name for the header and Mission Control (leave empty to use your username):', preferredName || '');
      if (next === null) return;
      const res = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferred_name: next }) }).catch(() => null);
      const body = res ? await res.json().catch(() => null) : null;
      if (!res || !res.ok) {
        window.alert((body && body.error) || 'Saving the display name failed.');
        return;
      }
      renderUserGreeting(body ? body.preferred_name : null);
    });

    // Reloading after sign-out drops every in-memory node; the empty session then shows the gate.
    document.getElementById('logout-button').addEventListener('click', async () => {
      if (devLoginEnabled) devFlag('aether.devSignedOut', '1');
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
      window.location.reload();
    });

    loadGraph().catch(err => console.error('Graph Load Error:', err));

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
    }
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" }
    });
  }
};

// "/node/<id>" (one trailing slash allowed) -> { id }; id is "" when it is not valid. Other paths -> null.
export function parseNodeRoute(pathname) {
  const match = /^\/node\/([^/]+)\/?$/.exec(String(pathname || ""));
  if (!match) return null;
  let id = "";
  try {
    id = decodeURIComponent(match[1]).trim();
  } catch {
    id = "";
  }
  return { id: id.length <= NODE_ID_MAX ? id : "" };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders }
  });
}

function timingSafeStringEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(String(a));
  const bufB = encoder.encode(String(b));
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Telegram sends the secret_token passed to setWebhook in this header. Fails closed if unset.
function isAuthorizedTelegram(request, env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.error("TELEGRAM_WEBHOOK_SECRET is not configured; rejecting webhook request.");
    return false;
  }
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return timingSafeStringEqual(provided, secret);
}

function isAuthorizedAdmin(request, env) {
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) return false;
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeStringEqual(provided, adminToken);
}

// Checked against when the username is unknown so login timing doesn't reveal which accounts exist.
const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

async function handleAuthRoute(request, env, url) {
  const route = url.pathname.slice("/api/auth/".length);
  if (route === "google" || route === "callback") return handleGoogleAuthRoute(request, env, url, route);
  if (route === "dev") return handleDevAuthRoute(request, env, url);
  const allowed = { login: "POST", logout: "POST", me: "GET", users: "POST" }[route];
  if (!allowed) return jsonResponse({ error: "Not found" }, 404);
  if (request.method !== allowed) {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: allowed });
  }

  if (route === "logout") {
    return jsonResponse({ success: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (route === "me") {
    const session = await getSessionUser(request, env);
    const user = session
      ? await env.DB.prepare("SELECT id, username, email, tier FROM users WHERE id = ?").bind(session.id).first()
      : null;
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
    const preferredName = await loadPreferredName(env, user.id);
    return jsonResponse({ user: { id: user.id, username: user.username, email: user.email || null, tier: user.tier || "free", preferred_name: preferredName, role: devRoleFor(env, url, user.id) } });
  }

  if (route === "login") {
    if (!env.SESSION_SECRET) {
      console.error("SESSION_SECRET is not configured; rejecting login.");
      return jsonResponse({ error: "Sign-in is not configured." }, 500);
    }
    if (!isSameOrigin(request, url)) return jsonResponse({ error: "Forbidden" }, 403);
    const body = await request.json().catch(() => null);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    const user = username
      ? await env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").bind(username).first()
      : null;
    const passwordOk = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user?.password_hash || !passwordOk) {
      return jsonResponse({ error: "Invalid username or password." }, 401);
    }
    const token = await signSession(user.id, env.SESSION_SECRET);
    return jsonResponse({ user: { id: user.id, username: user.username } }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  // route === "users": admin creates an account, or updates the password / Telegram link of an existing one.
  if (!isAuthorizedAdmin(request, env)) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = await request.json().catch(() => null);
  const username = String(body?.username || "").trim();
  if (!USERNAME_PATTERN.test(username)) {
    return jsonResponse({ error: "Username must be 3-32 letters, digits, dots, dashes or underscores." }, 400);
  }
  const password = body?.password === undefined ? null : String(body.password);
  if (password !== null && (password.length < PASSWORD_MIN_LENGTH || password.length > 200)) {
    return jsonResponse({ error: `Password must be ${PASSWORD_MIN_LENGTH}-200 characters.` }, 400);
  }
  // undefined keeps the current email; null or "" clears it. Google sign-in matches accounts by this email.
  const emailInput = body?.email;
  const email = emailInput === undefined || emailInput === null ? emailInput : String(emailInput).trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse({ error: "Email address is not valid." }, 400);
  // undefined keeps the current link; null or "" unlinks the chat.
  const chatInput = body?.telegramChatId;
  const chatId = chatInput === undefined || chatInput === null ? chatInput : String(chatInput).trim();
  if (chatId && !/^-?[0-9]{1,20}$/.test(chatId)) return jsonResponse({ error: "Telegram chat id must be numeric." }, 400);

  try {
    const passwordHash = password === null ? null : await hashPassword(password);
    const existing = await env.DB.prepare("SELECT id, username, password_hash, telegram_chat_id, email FROM users WHERE username = ?").bind(username).first();
    const nextChatId = chatId === undefined ? (existing?.telegram_chat_id ?? null) : (chatId || null);
    const nextEmail = email === undefined ? (existing?.email ?? null) : (email || null);
    if (existing) {
      await env.DB.prepare("UPDATE users SET password_hash = ?, telegram_chat_id = ?, email = ? WHERE id = ?")
        .bind(passwordHash || existing.password_hash, nextChatId, nextEmail, existing.id).run();
      return jsonResponse({ created: false, user: { id: existing.id, username: existing.username, telegramChatId: nextChatId, email: nextEmail } });
    }
    const id = "user_" + crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, telegram_chat_id, email) VALUES (?, ?, ?, ?, ?)")
      .bind(id, username, passwordHash, nextChatId, nextEmail).run();
    return jsonResponse({ created: true, user: { id, username, telegramChatId: nextChatId, email: nextEmail } }, 201);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return jsonResponse({ error: "That Telegram chat or email is already linked to another account." }, 409);
    }
    console.error("User Upsert Error:", err);
    return jsonResponse({ error: "Saving the user failed." }, 500);
  }
}

// Data routes: a valid session cookie, plus a same-origin check on writes (on top of SameSite=Lax).
// Live sync: tells the signed-in user's other tabs about a write this request made. The tab that made it sends its
// X-Aether-Client id, so it can skip its own event.
async function announceWrite(request, env, event) {
  try {
    const user = await getSessionUser(request, env);
    if (user) await publishGraphEvent(env, user.id, event, request.headers.get("X-Aether-Client"));
  } catch (err) {
    console.warn("Live sync publish failed:", err.message);
  }
}

async function authenticateUser(request, env, url) {
  const user = await getSessionUser(request, env);
  if (!user) return { error: jsonResponse({ error: "Unauthorized" }, 401) };
  if (request.method !== "GET" && !isSameOrigin(request, url)) {
    return { error: jsonResponse({ error: "Forbidden" }, 403) };
  }
  return { user };
}

function isSameOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

// Fails closed (no one is signed in) if SESSION_SECRET is unset.
function readCookie(request, name) {
  const prefix = name + "=";
  const cookie = (request.headers.get("Cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : null;
}

async function getSessionUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !env.SESSION_SECRET) return null;
  return verifySession(token, env.SESSION_SECRET);
}

// Google sign-in. GET /api/auth/google starts the redirect flow (PKCE + state in a short-lived signed cookie scoped
// to the callback); POST /api/auth/google takes a One Tap credential; GET /api/auth/callback finishes the redirect.
async function handleGoogleAuthRoute(request, env, url, route) {
  const methods = route === "google" ? ["GET", "POST"] : ["GET"];
  if (!methods.includes(request.method)) {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: methods.join(", ") });
  }
  const isJson = request.method === "POST";
  const fail = (message, status) => isJson
    ? jsonResponse({ error: message }, status)
    : redirectWithCookies(url.origin + "/?auth_error=" + encodeURIComponent(message), [oauthCookie("", 0)]);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    console.error("Google sign-in is missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or SESSION_SECRET.");
    return fail("Google sign-in is not configured.", 500);
  }
  const redirectUri = url.origin + "/api/auth/callback";

  if (route === "google" && request.method === "GET") {
    const { verifier, challenge } = await createPkcePair();
    const state = createOAuthState();
    const cookie = await signOAuthCookie(env.SESSION_SECRET, { state, verifier, next: safeNextPath(url.searchParams.get("next")) });
    return redirectWithCookies(
      buildGoogleAuthUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, state, codeChallenge: challenge }),
      [oauthCookie(cookie, OAUTH_COOKIE_TTL_SECONDS)]
    );
  }

  let claims;
  let next = "/";
  try {
    if (route === "google") {
      if (!isSameOrigin(request, url)) return jsonResponse({ error: "Forbidden" }, 403);
      const body = await request.json().catch(() => null);
      claims = await verifyGoogleIdToken(String(body?.credential || ""), env.GOOGLE_CLIENT_ID);
    } else {
      if (url.searchParams.get("error")) return fail("Google sign-in was cancelled.", 400);
      const saved = await readOAuthCookie(env.SESSION_SECRET, readCookie(request, OAUTH_COOKIE));
      const code = url.searchParams.get("code");
      if (!saved || !code || saved.state !== url.searchParams.get("state")) return fail("Sign-in expired. Please try again.", 400);
      next = safeNextPath(saved.next);
      const idToken = await exchangeGoogleCode({ code, verifier: saved.verifier, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri });
      claims = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
    }
  } catch (err) {
    console.warn("Google sign-in rejected:", err.message);
    return fail("Google sign-in failed. Please try again.", 401);
  }

  try {
    const result = await signInGoogleUser(env, claims);
    if (result.error) return fail(result.error, result.status);
    const session = sessionCookie(await signSession(result.user.id, env.SESSION_SECRET));
    if (isJson) return jsonResponse({ user: result.user, created: result.created }, 200, { "Set-Cookie": session });
    return redirectWithCookies(url.origin + next, [session, oauthCookie("", 0)]);
  } catch (err) {
    console.error("Google Sign-in Error:", err);
    return fail("Google sign-in failed. Please try again.", 500);
  }
}

// Local dev sign-in (src/dev-auth.js): GET /api/auth/dev?next=/path signs in the dev operator and redirects back.
// 404 unless DEV_AUTH_BYPASS is on and the request is to a loopback host.
async function handleDevAuthRoute(request, env, url) {
  if (!isDevAuthEnabled(env, url)) return jsonResponse({ error: "Not found" }, 404);
  if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
  if (!env.SESSION_SECRET) return jsonResponse({ error: "Set SESSION_SECRET in .dev.vars for dev sign-in." }, 500);
  const operator = await ensureDevOperator(env);
  let cookie = sessionCookie(await signSession(operator.id, env.SESSION_SECRET));
  // Plain http on a loopback host: drop Secure so every browser keeps the cookie.
  if (url.protocol === "http:") cookie = cookie.replace("; Secure", "");
  return redirectWithCookies(url.origin + safeNextPath(url.searchParams.get("next")), [cookie]);
}

// Matches the Google account by subject id, then by (verified) email; otherwise creates a free-tier account if the
// email is on GOOGLE_ALLOWED_EMAILS. Returns { user, created } or { error, status }.
async function signInGoogleUser(env, claims) {
  const email = String(claims.email).trim().toLowerCase();
  let user = await env.DB.prepare("SELECT id, username, email, tier, google_sub FROM users WHERE google_sub = ?").bind(claims.sub).first();
  if (!user) {
    user = await env.DB.prepare("SELECT id, username, email, tier, google_sub FROM users WHERE email = ? COLLATE NOCASE").bind(email).first();
    if (user?.google_sub && user.google_sub !== claims.sub) {
      return { error: "This email is already linked to a different Google account.", status: 409 };
    }
    if (user) await env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(claims.sub, user.id).run();
  }
  if (user) return { user: { id: user.id, username: user.username, tier: user.tier || "free" }, created: false };

  if (!isAllowedGoogleEmail(email, env.GOOGLE_ALLOWED_EMAILS)) {
    return { error: "This Google account has not been invited to Aether Portal.", status: 403 };
  }
  const base = usernameFromEmail(email);
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = attempt ? base.slice(0, 27) + "-" + Math.floor(1000 + Math.random() * 9000) : base;
    const id = "user_" + crypto.randomUUID();
    try {
      await env.DB.prepare("INSERT INTO users (id, username, email, google_sub, tier) VALUES (?, ?, ?, ?, 'free')")
        .bind(id, username, email, claims.sub).run();
      return { user: { id, username, tier: "free" }, created: true };
    } catch (err) {
      // A taken username gets a numbered retry; any other conflict (same email or Google id) is a real error.
      if (!String(err.message).includes("users.username")) throw err;
    }
  }
  throw new Error("Could not find a free username for " + email);
}

function oauthCookie(value, maxAge) {
  return `${OAUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/callback; Max-Age=${maxAge}`;
}

function redirectWithCookies(location, cookies) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach(cookie => headers.append("Set-Cookie", cookie));
  return new Response(null, { status: 302, headers });
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Token: base64url(JSON { sub, exp }) + "." + base64url(HMAC-SHA256 of the first part).
export async function signSession(userId, secret, now = Date.now()) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ sub: String(userId), exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })));
  return payload + "." + await hmacBase64Url(secret, payload);
}

export async function verifySession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!timingSafeStringEqual(parts[1], await hmacBase64Url(secret, parts[0]))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    if (typeof data?.sub !== "string" || !data.sub || !(Number(data.exp) * 1000 > now)) return null;
    return { id: data.sub };
  } catch (err) {
    return null;
  }
}

async function hmacBase64Url(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

// Stored as pbkdf2$<iterations>$<salt>$<hash>, both base64url.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterationText, saltText, hashText] = String(stored || "").split("$");
    const iterations = Number.parseInt(iterationText, 10);
    if (scheme !== "pbkdf2" || !hashText || !(iterations > 0 && iterations <= PBKDF2_ITERATIONS)) return false;
    const hash = await derivePasswordBits(password, base64UrlToBytes(saltText), iterations);
    return timingSafeStringEqual(bytesToBase64Url(hash), hashText);
  } catch (err) {
    return false;
  }
}

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text) {
  const base64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "===".slice((base64.length + 3) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

// D1 stores CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" (UTC); browsers parse that inconsistently.
function toIsoTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(" ", "T") + "Z" : text;
}

// The research column is a JSON array; anything unreadable counts as no history.
export function normalizeNodeStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return NODE_STATUSES.includes(status) ? status : "inbox";
}

export function parseResearch(value) {
  if (!value) return [];
  try {
    const entries = JSON.parse(String(value));
    return Array.isArray(entries) ? entries.filter(entry => entry && entry.question && entry.answer) : [];
  } catch (err) {
    return [];
  }
}

// Adds one Q&A to the node's history (oldest dropped past the cap) and returns the saved list.
async function appendResearch(env, userId, nodeId, { question, answer, sources }) {
  const row = await env.DB.prepare("SELECT research FROM saved_nodes WHERE id = ? AND user_id = ?").bind(nodeId, userId).first();
  if (!row) return null;
  const entry = {
    question,
    answer: answer.length > RESEARCH_ANSWER_MAX ? answer.slice(0, RESEARCH_ANSWER_MAX - 1).trimEnd() + "…" : answer,
    sources: Array.isArray(sources) ? sources : [],
    asked_at: new Date().toISOString()
  };
  const research = [...parseResearch(row?.research), entry].slice(-RESEARCH_MAX_ENTRIES);
  await env.DB.prepare("UPDATE saved_nodes SET research = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .bind(JSON.stringify(research), nodeId, userId).run();
  return research;
}

// Runs after /api/share has answered: fills in link metadata, fetches the page (or YouTube captions) when a preset
// needs it, runs the preset on the chosen tier and saves the result as a research entry on the node.
async function processSharedNode(env, userId, nodeId, share) {
  if (share.url) {
    try {
      const metadata = await fetchLinkMetadata(share.url);
      if (metadata) {
        await env.DB.prepare(
          "UPDATE saved_nodes SET title = CASE WHEN ? THEN title ELSE COALESCE(?, title) END, description = COALESCE(description, ?), image_url = COALESCE(image_url, ?), site_name = COALESCE(site_name, ?), source_url = COALESCE(source_url, ?), favicon_url = COALESCE(favicon_url, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
        ).bind(share.hasSharedTitle ? 1 : 0, metadata.title, metadata.description, metadata.image, metadata.siteName, metadata.sourceUrl, metadata.favicon, nodeId, userId).run();
      }
    } catch (err) {
      console.warn("Share metadata failed:", err.message);
    }
  }
  if (!share.preset) return;

  let content = "";
  const videoId = share.url ? getYouTubeVideoId(share.url) : null;
  try {
    if (videoId) {
      const captions = await fetchYouTubeTranscript(videoId);
      if (captions) {
        content = captions.text;
        await env.DB.prepare("UPDATE saved_nodes SET raw_transcript = ? WHERE id = ? AND user_id = ?").bind(content, nodeId, userId).run();
      }
    } else if (share.url) {
      content = (await fetchWebContent(share.url)).content;
      await env.DB.prepare("UPDATE saved_nodes SET content = ? WHERE id = ? AND user_id = ?").bind(content, nodeId, userId).run();
    }
  } catch (err) {
    console.warn("Share content fetch failed:", err.message);
  }

  const prompt = buildPresetPrompt(share.preset, { title: share.title, url: share.url, note: share.note, content });
  const label = SHARE_PRESET_LABELS[share.preset] + " · " + SHARE_TIER_LABELS[share.tier];
  let answer;
  try {
    if (share.tier === "claude") answer = await callClaude(env.ANTHROPIC_API_KEY, prompt);
    else answer = (await callGeminiText(env.GEMINI_API_KEY, share.tier === "pro" ? GEMINI_PRO_MODELS : GEMINI_MODELS, prompt, 4096, false)).text.trim();
  } catch (err) {
    console.error("Share preset failed:", err);
    answer = "";
  }
  // A failed run is recorded too, so the card says what happened instead of showing nothing.
  await appendResearch(env, userId, nodeId, {
    question: label,
    answer: answer || "This action could not run when the link was shared. Ask Elarion on the card to try again.",
    sources: []
  }).catch(err => console.warn("Share result save failed:", err.message));
}

function extractKeywords(text) {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function buildGraphLinks(nodes) {
  const keywordSets = nodes.map(node => extractKeywords((node.name || "") + " " + (node.url || "")));
  const candidates = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let commonKeywords = 0;
      keywordSets[i].forEach(kw => {
        if (keywordSets[j].has(kw)) commonKeywords++;
      });
      if (commonKeywords > 0) candidates.push({ i, j, value: commonKeywords });
    }
  }

  // Keep only each node's strongest semantic links so common words don't produce a dense hairball.
  candidates.sort((a, b) => b.value - a.value);
  const degree = new Array(nodes.length).fill(0);
  const linkedPairs = new Set();
  const links = [];

  for (const { i, j, value } of candidates) {
    if (degree[i] >= MAX_SEMANTIC_LINKS_PER_NODE || degree[j] >= MAX_SEMANTIC_LINKS_PER_NODE) continue;
    degree[i]++;
    degree[j]++;
    linkedPairs.add(i + ":" + j);
    links.push({ source: nodes[i].id, target: nodes[j].id, value, type: "semantic" });
  }

  // Chain nodes within each category so clusters stay together with O(n) edges instead of O(n²).
  const lastIndexByCategory = new Map();
  nodes.forEach((node, index) => {
    const prev = lastIndexByCategory.get(node.group);
    if (prev !== undefined && !linkedPairs.has(prev + ":" + index)) {
      links.push({ source: nodes[prev].id, target: node.id, value: 0.5, type: "category" });
    }
    lastIndexByCategory.set(node.group, index);
  });

  return links;
}

function inferNodeCategory(rawUrl, fallback = "note") {
  if (String(fallback || "").toLowerCase() === OUTCOME_CATEGORY) return OUTCOME_CATEGORY;
  const value = String(rawUrl || "").toLowerCase();
  if (VIDEO_URL_PATTERN.test(value)) {
    return "video";
  }
  if (String(fallback || "").toLowerCase() === "video") return "video";
  return normalizeCategory(fallback, "note");
}

function normalizeCategory(rawCategory, fallback = "note") {
  const value = String(rawCategory || fallback).trim().toLowerCase().replace(/\s+/g, "_");

  if (VALID_CATEGORIES.includes(value)) return value;
  if (value.includes("task") || value.includes("todo") || value.includes("build")) return "dev_task";
  if (value.includes("money") || value.includes("revenue") || value.includes("pricing") || value.includes("monet")) return "monetization";
  if (value.includes("ai") || value.includes("gemini") || value.includes("tool") || value.includes("llm")) return "ai_tool";
  if (value.includes("market") || value.includes("brand") || value.includes("campaign") || value.includes("growth")) return "marketing";
  if (value.includes("route") || value.includes("plan") || value.includes("roadmap") || value.includes("launch")) return "route_plan";
  return fallback;
}

// "/cmd args" or "/cmd@BotName args" -> { command, args }; anything else (including paths like /a/b) -> null.
export function parseTelegramCommand(text) {
  const match = /^\/([a-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
  return match ? { command: match[1].toLowerCase(), args: String(match[2] || "").trim() } : null;
}

// The /help reply; the web app's Telegram Commands modal shows the same list.
export function buildTelegramHelp() {
  return [
    "🌌 Elarion command guide",
    "",
    ...TELEGRAM_COMMANDS.map(({ usage, description }) => `${usage}\n   ${description}`),
    "",
    "📎 Link + comment pairing",
    `Send a link, then any text within ${LINK_PAIRING_WINDOW_SECONDS / 60} minutes: it is added to that link as your note instead of becoming a new node. Text in the same message as a link is kept as its note too. Use /note to save text on its own.`,
    "",
    "📸 Photos",
    `Send a photo (or an image file) and Elarion titles, describes and tags it. A caption, or text sent within ${LINK_PAIRING_WINDOW_SECONDS / 60} minutes, is added as its note.`,
    "",
    "Anything else you send is saved to your graph: links become link nodes, text becomes notes."
  ].join("\n");
}

// Body of the web app's Telegram Commands modal, built from the same command list as /help.
function renderTelegramHelpHtml() {
  const minutes = LINK_PAIRING_WINDOW_SECONDS / 60;
  const rows = TELEGRAM_COMMANDS.map(({ usage, description }) =>
    `<div class="command-row"><code>${escapeHtmlText(usage)}</code><span>${escapeHtmlText(description)}</span></div>`
  ).join("\n        ");
  return `<p class="help-lead">Type <code>/</code> in your Aether bot chat to pick a command from Telegram's autocomplete.</p>
      <div class="command-list">
        ${rows}
      </div>
      <h4>📎 Link + comment pairing</h4>
      <ol class="help-steps">
        <li>Send a link to the bot. It is saved as a link node with its title, preview image and favicon.</li>
        <li>Send any text within <strong>${minutes} minutes</strong>. Instead of becoming a new node, it is added to that link as <em>📝 Your note</em>. Several messages in a row are all added.</li>
        <li>After ${minutes} minutes, text is saved as its own note again.</li>
      </ol>
      <p>Text in the same message as a link (before or after it) is kept as that link's note. To save text separately even right after a link, start it with <code>/note</code>.</p>
      <h4>📸 Photos</h4>
      <p>Send a photo, or an image as a file (JPEG, PNG, WebP or GIF). Elarion gives it a title, a short description and tags, and saves it as an <em>image</em> node. A caption, or any text within ${minutes} minutes, is added as its note, just like a link.</p>
      <h4>Everything else</h4>
      <p>Anything you send without a command is saved to your graph: links become link nodes, text becomes notes. <code>/research</code> answers are saved too: a researched link keeps the answer in its card's Past Research, and a researched topic becomes a new node.</p>`;
}

function escapeHtmlText(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, char => entities[char]);
}

async function handleTelegramCommand(env, chatId, userId, { command, args }) {
  switch (command) {
    case "start":
    case "help":
      return sendTelegram(env, chatId, buildTelegramHelp());
    case "note":
      if (!args) return sendTelegram(env, chatId, "Add your note after /note, e.g. /note call the supplier.");
      return saveTelegramNote(env, chatId, userId, args);
    case "link": {
      const message = splitLinkMessage(args);
      if (!message.url) return sendTelegram(env, chatId, "Add a web address after /link, e.g. /link https://example.com great read");
      return saveTelegramLink(env, chatId, userId, message.url, message.note);
    }
    case "ask":
      if (!args) return sendTelegram(env, chatId, "Add a question after /ask, e.g. /ask what have I saved about pricing?");
      return telegramAsk(env, chatId, userId, args);
    case "research":
      if (!args) return sendTelegram(env, chatId, "Add a topic or link after /research, e.g. /research vector databases for small teams");
      return telegramResearch(env, chatId, userId, args);
    default:
      return sendTelegram(env, chatId, `Unknown command /${command}. Send /help for the command guide.`);
  }
}

// The image a Telegram message carries: the largest photo size, or an image sent as a file (raster types only,
// so an SVG can never be served from this origin). Returns { fileId, fileSize } or null.
export function pickTelegramImage(message) {
  const photos = Array.isArray(message?.photo) ? message.photo.filter(size => size?.file_id) : [];
  if (photos.length) {
    const largest = photos.reduce((best, size) => ((size.width || 0) * (size.height || 0) > (best.width || 0) * (best.height || 0) ? size : best));
    return { fileId: String(largest.file_id), fileSize: Number(largest.file_size) || 0 };
  }
  const doc = message?.document;
  if (doc?.file_id && TELEGRAM_IMAGE_MIME_TYPES.includes(String(doc.mime_type || "").toLowerCase())) {
    return { fileId: String(doc.file_id), fileSize: Number(doc.file_size) || 0 };
  }
  return null;
}

// Photos: Gemini names, describes and tags them. The file stays on Telegram and the web app loads it through
// /api/node-image/:id, so no bot token or expiring download URL is ever stored.
async function saveTelegramImage(env, chatId, userId, { fileId, fileSize, caption }) {
  if (fileSize > TELEGRAM_FILE_MAX_BYTES) {
    await sendTelegram(env, chatId, "That image is over Telegram's 20 MB bot download limit. Please send a smaller version.");
    return;
  }
  await sendTelegramTyping(env, chatId);
  const note = caption ? caption.slice(0, USER_NOTE_MAX) : null;

  let described = null;
  try {
    const file = await downloadTelegramFile(env, fileId);
    if (file && env.GEMINI_API_KEY) described = await describeImageWithGemini(env, file.bytes, file.mimeType, note);
  } catch (err) {
    console.warn("Telegram photo processing failed:", err.message);
  }

  const id = "node_" + crypto.randomUUID();
  const title = described?.title || "Photo · " + new Date().toISOString().slice(0, 10);
  const description = described
    ? [described.caption, described.tags.length ? "Tags: " + described.tags.map(tag => "#" + tag).join(" ") : ""].filter(Boolean).join("\n\n")
    : null;
  await env.DB.prepare(
    "INSERT INTO saved_nodes (id, user_id, url, title, description, category, image_url, site_name, telegram_file_id, user_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, "", title, description, "image", `/api/node-image/${id}`, "Telegram", fileId, note).run();
  await saveUserTags(env, userId, id, note);

  const pairing = `\nText you send in the next ${LINK_PAIRING_WINDOW_SECONDS / 60} minutes is added to this photo.`;
  await sendTelegram(
    env,
    chatId,
    described
      ? `📸 Photo saved & processed: "${title}"${described.tags.length ? "\n🏷️ " + described.tags.map(tag => "#" + tag).join(" ") : ""}${note ? "\n📝 Your caption is attached." : ""}${pairing}`
      : `📸 Photo saved: "${title}"\nElarion couldn't describe it right now; the image is still in your graph.${note ? "\n📝 Your caption is attached." : ""}${pairing}`
  );
}

// getFile + download. Returns { bytes, mimeType } or null.
async function downloadTelegramFile(env, fileId) {
  const file = await fetchTelegramFile(env, fileId);
  if (!file) return null;
  return { bytes: new Uint8Array(await file.response.arrayBuffer()), mimeType: file.imageType };
}

// Resolves a file_id to a fresh download: { response (streaming), imageType }, or null.
// The type comes from the file extension (Telegram's file server doesn't reliably send one).
async function fetchTelegramFile(env, fileId) {
  const info = await telegramApi(env, "getFile", { file_id: fileId });
  const body = info.ok ? await info.json().catch(() => null) : null;
  const filePath = body?.result?.file_path;
  if (!filePath) return null;
  const base = String(env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const response = await fetch(`${base}/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const extension = String(filePath).split(".").pop().toLowerCase();
  return { response, imageType: IMAGE_TYPES_BY_EXTENSION[extension] || "image/jpeg" };
}

// Vision call: Flash-Lite first, Flash if it's busy. GEMINI_API_BASE (optional) points it at a local stub during development.
async function describeImageWithGemini(env, bytes, mimeType, userCaption) {
  const base = String(env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const prompt = `You are cataloguing a photo for the user's personal knowledge graph.${userCaption ? ` The user's caption: "${userCaption.slice(0, 500)}".` : ""}
Return JSON: {"title": "...", "caption": "...", "tags": ["..."]}
- title: 3 to 8 words naming what the photo shows or is about (a screenshot's topic, a document's subject, a place, an object). No quotes, no trailing period.
- caption: 1 to 3 sentences describing the useful content. Transcribe key text if it is a screenshot, receipt, slide or document.
- tags: 3 to 8 short lowercase topic tags, no # signs.`;
  const payload = {
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: bytesToBase64(bytes) } }, { text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } }
  };
  let lastError;
  for (const model of ASK_TIER1_MODELS) {
    try {
      const response = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw Object.assign(new Error(`Gemini vision error (${model}): ${response.status} ${detail}`), { status: response.status });
      }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
      return parseImageDescription(JSON.parse(text.replace(/```json|```/gi, "").trim()));
    } catch (err) {
      lastError = err;
      if (!GEMINI_RETRYABLE_STATUSES.includes(err.status)) throw err;
      console.warn(`Gemini ${model} unavailable (${err.status}); trying next model.`);
    }
  }
  throw lastError;
}

// Normalises Gemini's { title, caption, tags }; null without a usable title.
export function parseImageDescription(raw) {
  const title = String(raw?.title || "").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”.]+$/g, "").trim().slice(0, 80);
  if (!title) return null;
  const caption = String(raw?.caption || raw?.summary || "").replace(/\s+/g, " ").trim().slice(0, 800);
  const tags = [...new Set((Array.isArray(raw?.tags) ? raw.tags : [])
    .map(tag => String(tag).toLowerCase().replace(/^#+/, "").replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-"))
    .filter(Boolean))].slice(0, 8);
  return { title, caption, tags };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Saves a link node (metadata fetched now) and confirms it unless `quiet`. Returns the saved row's fields.
async function saveTelegramLink(env, chatId, userId, linkUrl, noteText, { quiet = false } = {}) {
  const id = "node_" + crypto.randomUUID();
  linkUrl = cleanLinkUrl(linkUrl);
  const category = inferNodeCategory(linkUrl, "link");
  const metadata = await fetchLinkMetadata(linkUrl);
  const title = metadata?.title || fallbackLinkTitle(linkUrl);
  const description = metadata?.description || null;
  const note = noteText ? noteText.slice(0, USER_NOTE_MAX) : null;
  await env.DB.prepare(
    "INSERT INTO saved_nodes (id, user_id, url, title, description, category, image_url, site_name, source_url, favicon_url, user_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, linkUrl, title, description, category, metadata?.image || null, metadata?.siteName || null, metadata?.sourceUrl || null, metadata?.favicon || null, note).run();
  await saveUserTags(env, userId, id, note);
  if (!quiet) {
    await sendTelegram(
      env,
      chatId,
      `🌌 Received! Stashed into the Aether Portal for Elarion to inspect with our big brain.\n🧠 Saved as [${category.toUpperCase()}]: "${title}"${note ? "\n📝 Your note is attached." : ""}\nText you send in the next ${LINK_PAIRING_WINDOW_SECONDS / 60} minutes is added to this link.`
    );
  }
  return { id, title, category, url: linkUrl, description, user_note: note };
}

async function saveTelegramNote(env, chatId, userId, text) {
  const category = text.length > 100 ? "article" : "note";
  const title = text.length > 30 ? text.slice(0, 30) + "..." : text;
  // Notes keep their full text in url (the card and Ask read it from there).
  const id = "node_" + crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO saved_nodes (id, user_id, url, title, description, category) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, text, title, null, category).run();
  await saveUserTags(env, userId, id, text);
  await sendTelegram(
    env,
    chatId,
    `🌌 Received! Stashed into the Aether Portal for Elarion to inspect with our big brain.\n🧠 Saved as [${category.toUpperCase()}]: "${title}"`
  );
}

async function telegramAsk(env, chatId, userId, question) {
  const result = await askFromTelegram(env, chatId, userId, question);
  if (result) await sendTelegramChunks(env, chatId, formatTelegramAnswer("💬 Elarion", result));
}

// /research always uses web search. A link is saved and the answer kept in its card's Past Research;
// a topic's answer is saved as a new article node so it joins the graph.
async function telegramResearch(env, chatId, userId, args) {
  const { url: linkUrl, note } = splitLinkMessage(args);
  if (linkUrl) {
    await sendTelegramTyping(env, chatId);
    const link = await saveTelegramLink(env, chatId, userId, linkUrl, null, { quiet: true });
    const question = note || "Research this link: what it is, the key takeaways, how credible and current it is, and how it relates to my saved notes.";
    const result = await askFromTelegram(env, chatId, userId, question, { forceWeb: true, focus: link });
    if (!result) {
      await sendTelegram(env, chatId, `🔗 The link was still saved as [${link.category.toUpperCase()}]: "${link.title}".`);
      return;
    }
    try {
      await appendResearch(env, userId, link.id, { question, answer: result.answer, sources: result.sources });
    } catch (err) {
      console.warn("Telegram research save failed:", err.message);
    }
    await sendTelegramChunks(
      env,
      chatId,
      formatTelegramAnswer(`🔎 Research: ${link.title}`, result) + `\n\n🔗 Saved as [${link.category.toUpperCase()}] with this research on its card.`
    );
    return;
  }

  const result = await askFromTelegram(env, chatId, userId, args, { forceWeb: true });
  if (!result) return;
  const topic = args.replace(/\s+/g, " ");
  const title = ("Research: " + topic).slice(0, 80);
  await env.DB.prepare(
    "INSERT INTO saved_nodes (id, user_id, url, title, description, category) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind("node_" + crypto.randomUUID(), userId, "", title, formatTelegramAnswer("", result).trim().slice(0, NODE_CONTENT_MAX), "article").run();
  await sendTelegramChunks(env, chatId, formatTelegramAnswer(`🔎 Research: ${topic}`, result) + `\n\n🧠 Saved to your graph as "${title}".`);
}

// Ranks the user's nodes against the question and asks Elarion. Returns { answer, sources, tier } or null
// after telling the user what went wrong.
async function askFromTelegram(env, chatId, userId, question, { forceWeb = false, focus = null } = {}) {
  if (!env.GEMINI_API_KEY) {
    await sendTelegram(env, chatId, "Elarion isn't configured yet (missing Gemini API key).");
    return null;
  }
  if (question.length > ASK_MAX_QUESTION_LENGTH) {
    await sendTelegram(env, chatId, `Please keep questions under ${ASK_MAX_QUESTION_LENGTH} characters.`);
    return null;
  }
  await sendTelegramTyping(env, chatId);
  const { results } = await env.DB.prepare(
    "SELECT id, title, description, category, url, user_note FROM saved_nodes WHERE user_id = ? ORDER BY rowid DESC LIMIT 2000"
  ).bind(userId).all();
  const others = (results || []).filter(row => !focus || row.id !== focus.id);
  const rows = rankNodesForQuestion(others, question, TELEGRAM_CONTEXT_NODES - (focus ? 1 : 0));
  if (focus) rows.unshift(focus);
  const scope = focus
    ? "a link the user just saved (marked focus), followed by their saved nodes that best match the question, then their most recent ones"
    : "the user's saved nodes that best match the question, followed by their most recent ones";

  let reply;
  try {
    reply = await askGemini(env, question, webSearch => buildAskPrompt(question, "", focus ? focus.id : null, rows, webSearch, scope), { forceWeb });
  } catch (err) {
    console.error("Telegram ask failed:", err);
    await sendTelegram(env, chatId, "Elarion couldn't answer right now. Please try again in a minute.");
    return null;
  }
  const answer = String(reply.text || "").trim();
  if (!answer) {
    await sendTelegram(env, chatId, "Elarion returned an empty answer. Try rephrasing the question.");
    return null;
  }
  return { answer, sources: reply.sources || [], tier: reply.tier };
}

// Keyword matches first (title hits weigh more), then the rest in their given (newest-first) order.
export function rankNodesForQuestion(nodes, question, limit) {
  const terms = [...new Set(String(question || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2 && !STOP_WORDS.has(word)))];
  const scored = (nodes || []).map((node, index) => {
    const title = String(node.title || "").toLowerCase();
    const body = [node.description, node.user_note, node.url, node.category].map(value => String(value || "").toLowerCase()).join(" ");
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
    return { node, score, index };
  });
  const matches = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const others = scored.filter(item => item.score === 0);
  return [...matches, ...others].slice(0, Math.max(0, limit)).map(item => item.node);
}

// Heading, answer, then up to TELEGRAM_SOURCES_MAX web sources, as plain text.
export function formatTelegramAnswer(heading, { answer, sources, tier }) {
  const lines = [];
  if (heading) lines.push(heading + (tier === 2 ? " · web-grounded" : ""), "");
  lines.push(String(answer || "").trim());
  const list = (Array.isArray(sources) ? sources : []).filter(source => source && source.uri).slice(0, TELEGRAM_SOURCES_MAX);
  if (list.length) lines.push("", "Sources:", ...list.map(source => `- ${source.title || source.uri} — ${source.uri}`));
  return lines.join("\n");
}

// Splits text under Telegram's message limit, preferring paragraph, then line, then word breaks.
export function chunkTelegramMessage(text, max = TELEGRAM_MESSAGE_MAX) {
  const chunks = [];
  let rest = String(text || "");
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

// Every Bot API call goes through here. TELEGRAM_API_BASE (optional) points calls at a local stub during development.
async function telegramApi(env, method, payload) {
  const base = String(env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const response = await fetch(`${base}/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) console.warn(`Telegram ${method} failed with HTTP ${response.status}`);
  return response;
}

async function sendTelegram(env, chatId, text) {
  return telegramApi(env, "sendMessage", { chat_id: chatId, text });
}

async function sendTelegramChunks(env, chatId, text) {
  for (const chunk of chunkTelegramMessage(text)) await sendTelegram(env, chatId, chunk);
}

// "typing…" in the chat while Elarion works; failures don't matter.
async function sendTelegramTyping(env, chatId) {
  await telegramApi(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => null);
}

// Publishes the "/" autocomplete list. Descriptions carry the usage hint (Telegram's limit is 256 characters).
async function registerTelegramCommands(env) {
  const commands = TELEGRAM_COMMANDS.map(({ command, usage, description }) => ({ command, description: `${description} · ${usage}`.slice(0, 256) }));
  const response = await telegramApi(env, "setMyCommands", { commands });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

// Pulls the first http(s) URL out of a message; the remaining text is the note. Trailing punctuation and an
// unbalanced closing parenthesis belong to the sentence, not the URL.
export function splitLinkMessage(text) {
  const value = String(text || "");
  const match = /https?:\/\/[^\s<>"]+/i.exec(value);
  if (!match) return { url: "", note: value.trim() };
  let url = match[0].replace(/[.,!?;:'"]+$/, "");
  while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
  const note = (value.slice(0, match.index) + " " + value.slice(match.index + url.length))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "")
    .trim();
  return { url, note };
}

// Appends text to a node's user_note (blank line between entries, capped). Returns false if the node is gone.
async function attachUserNote(env, userId, nodeId, text) {
  const note = String(text || "").trim().slice(0, USER_NOTE_MAX);
  if (!note) return false;
  const result = await env.DB.prepare(
    "UPDATE saved_nodes SET user_note = substr(CASE WHEN user_note IS NULL OR user_note = '' THEN ? ELSE user_note || char(10) || char(10) || ? END, 1, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
  ).bind(note, note, USER_NOTE_MAX, nodeId, userId).run();
  if (!result?.meta?.changes) return false;
  await saveUserTags(env, userId, nodeId, note);
  return true;
}

function isGenericPlaceholder(text) {
  const lower = String(text || "").toLowerCase();
  return /(look into this|look into that|look into it|check this out|look at this|something like this|placeholder|tbd)/.test(lower) || lower === "this" || lower === "that";
}

// Finds the link or photo saved in the `windowSeconds` before `referenceTime` (a D1 timestamp, or null for now).
// Only the same user's links count, so a note never borrows another account's context.
async function findRecentLinkContext(env, userId, referenceTime, excludeId = null, windowSeconds = 60) {
  try {
    const ref = referenceTime ? String(referenceTime) : "now";
    return await env.DB.prepare(
      "SELECT id, title, description, url, category FROM saved_nodes WHERE user_id = ? AND (url LIKE 'http://%' OR url LIKE 'https://%' OR category = 'image') AND id != ? AND created_at <= datetime(?) AND created_at >= datetime(?, ?) ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).bind(userId, excludeId || "", ref, ref, `-${Math.max(1, Math.floor(windowSeconds))} seconds`).first();
  } catch (err) {
    console.error("Recent link context lookup failed:", err);
    return null;
  }
}

// Returns null if Gemini wasn't called or failed, otherwise { changed }.
async function reclusterNode(env, apiKey, node) {
  const category = String(node.category || "").toLowerCase();
  if (!RECLUSTER_CATEGORIES.includes(category)) return null;

  const fallbackCategory = category === "link" ? "link" : "note";
  const currentTitle = String(node.title || "");
  const currentUrl = String(node.url || "");
  // For links, pass the stored (possibly fetched) title along so Gemini doesn't have to guess from the URL alone.
  const hasDistinctLinkTitle = /^https?:/i.test(currentUrl) && currentTitle && currentTitle !== currentUrl;
  const sourceText = (hasDistinctLinkTitle ? currentUrl + " | " + currentTitle : (currentUrl || currentTitle)).trim();

  let analysisText = sourceText;
  let nextUrl = currentUrl;
  if (isGenericPlaceholder(currentTitle) || isGenericPlaceholder(sourceText)) {
    const context = await findRecentLinkContext(env, node.user_id, node.created_at, node.id);
    if (context) {
      analysisText = [sourceText, context.title, context.url].filter(Boolean).join(" | ");
      nextUrl = String(context.url || currentUrl);
    }
  }

  const analysis = await analyzeWithGemini(apiKey, analysisText, fallbackCategory);
  if (!analysis) return null;

  const nextCategory = normalizeCategory(analysis.category, fallbackCategory);
  const nextTitle = analysis.title || currentTitle || "Untitled note";
  if (nextCategory === category && nextTitle === currentTitle && nextUrl === currentUrl) return { changed: false };

  await env.DB.prepare(
    "UPDATE saved_nodes SET title = ?, category = ?, url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(nextTitle, nextCategory, nextUrl, node.id).run();
  return { changed: true };
}

// Returns { title, category } or null if Gemini failed or returned something unusable.
async function analyzeWithGemini(apiKey, rawText, fallbackCategory = "note") {
  const sourceText = String(rawText || "").trim();
  if (!sourceText) return null;

  const prompt = `You are cleaning a saved knowledge item. Use the exact source content or URL to infer a better title and category. Return only valid JSON: {"title":"...","category":"note|link|article|dev_task|monetization|ai_tool|marketing|route_plan|general"}. Source: ${sourceText}`;

  try {
    const parsed = await callGeminiJson(apiKey, prompt, 2048);
    const title = String(parsed?.title || "").trim().slice(0, 200);
    if (!title) throw new Error("Gemini returned no title");
    const category = normalizeCategory(parsed.category, sourceText.startsWith("http") ? "link" : fallbackCategory);

    return { title, category };
  } catch (err) {
    console.error("Gemini analysis failed:", err);
    return null;
  }
}

// Focus node first, then its neighbors (or every node of a cluster), one line each.
// `scopeText` overrides the description of which nodes are included (Telegram picks them by keyword).
function buildAskPrompt(question, label, focusId, rows, webSearch, scopeText = null) {
  const ordered = [...rows].sort((a, b) => (String(b.id) === focusId) - (String(a.id) === focusId));
  const lines = ordered.map(row => {
    const title = String(row.title || row.url || "Untitled").replace(/\s+/g, " ").slice(0, 200);
    const url = String(row.url || "").split(/\s+/)[0];
    const description = String(row.description || (url === row.url ? "" : row.url) || "").replace(/\s+/g, " ").slice(0, ASK_DESCRIPTION_LENGTH);
    const note = String(row.user_note || "").replace(/\s+/g, " ").slice(0, ASK_DESCRIPTION_LENGTH);
    const marker = String(row.id) === focusId ? " (focus)" : "";
    return `- [${row.category || "note"}]${marker} ${title}${url && url !== title ? ` — ${url}` : ""}${description ? ` — ${description}` : ""}${note ? ` — user's note: ${note}` : ""}`;
  });
  const scope = scopeText || (focusId
    ? "a saved node (marked focus) and the nodes linked to it"
    : `every saved node in the "${label || "selected"}" category`);
  return `You are Elarion, the research assistant of a personal knowledge graph. Below is ${scope}. These nodes are the user's own saved notes: treat them as the starting context and ground truth for what the user has saved, thinks, or plans.

Do not limit yourself to the notes. Whenever the question needs outside context (for example relocation options, market or product comparisons, technology evaluations, current events, or general research), use your full analytical reasoning and general knowledge, and connect it back to the notes. ${webSearch
    ? "Web search is available: use it for current, real-world facts."
    : "Web search is not available for this answer: rely on general knowledge, flag anything that may be out of date, and suggest the user ask again with 'research' or 'latest' for live information."}

Structure every answer in these labeled sections, each starting on its own line:
Notes in your graph: what the saved nodes say that is relevant, citing node titles. If nothing relevant, say so in one line.
Elarion External Synthesis: your own analysis, outside knowledge, and research findings, clearly separate from the notes. Flag uncertainty and anything time-sensitive. Omit this section only if the question is purely about the notes.

Keep it concise; plain text, short paragraphs or "- " bullets, no markdown headings, bold, or tables.

Nodes:
${lines.join("\n") || "(no saved nodes)"}

Question: ${question}`;
}

// Sends one prompt to Gemini Flash in JSON mode and returns the parsed object. Throws on HTTP or parse errors.
async function callGeminiJson(apiKey, prompt, maxOutputTokens) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      return await callGeminiModelJson(apiKey, model, prompt, maxOutputTokens);
    } catch (err) {
      lastError = err;
      if (!GEMINI_RETRYABLE_STATUSES.includes(err.status)) throw err;
      console.warn(`Gemini ${model} unavailable (${err.status}); trying next model.`);
    }
  }
  throw lastError;
}

async function callGeminiModelJson(apiKey, model, prompt, maxOutputTokens) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens,
        responseMimeType: "application/json",
        // 3.x Flash can't disable thinking; "low" keeps it cheap. Thinking tokens count against maxOutputTokens,
        // so callers leave headroom above the JSON they expect.
        thinkingConfig: { thinkingLevel: "low" }
      }
    })
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw Object.assign(new Error(`Gemini API error (${model}): ${response.status} ${detail}`), { status: response.status });
  }

  const data = await response.json();
  const rawModelText = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
  return JSON.parse(rawModelText.replace(/```json|```/gi, "").trim());
}

export function needsWebResearch(question) {
  return WEB_RESEARCH_PATTERN.test(String(question || ""));
}

// Routes an Ask question: research-intent questions (or forceWeb, used by /research) try search-grounded
// Flash (Tier 2) and fall back to tool-free Flash-Lite (Tier 1) on any error; everything else goes straight to Tier 1.
async function askGemini(env, question, buildPrompt, { forceWeb = false } = {}) {
  const searchAllowed = String(env.ELARION_WEB_SEARCH || "").toLowerCase() !== "off";
  if (searchAllowed && (forceWeb || needsWebResearch(question))) {
    try {
      return { ...(await callGeminiText(env.GEMINI_API_KEY, ASK_TIER2_MODELS, buildPrompt(true), 8192, true)), tier: 2 };
    } catch (err) {
      console.warn("Ask Tier 2 (search) failed; falling back to Tier 1:", err.message);
    }
  }
  return { ...(await callGeminiText(env.GEMINI_API_KEY, ASK_TIER1_MODELS, buildPrompt(false), 4096, false)), tier: 1 };
}

// Sends one plain-text prompt to Gemini, optionally grounded with Google Search. Returns { text, sources }.
// Plain text (not JSON mode) because older models reject JSON output combined with the search tool.
// videoUrl attaches a public YouTube video for Gemini to watch alongside the prompt.
async function callGeminiText(apiKey, models, prompt, maxOutputTokens, useSearch, videoUrl = null) {
  let lastError;
  for (const model of models) {
    try {
      return await callGeminiModelText(apiKey, model, prompt, maxOutputTokens, useSearch, videoUrl);
    } catch (err) {
      lastError = err;
      if (!GEMINI_RETRYABLE_STATUSES.includes(err.status)) throw err;
      console.warn(`Gemini ${model} unavailable (${err.status}); trying next model.`);
    }
  }
  throw lastError;
}

async function callGeminiModelText(apiKey, model, prompt, maxOutputTokens, useSearch, videoUrl = null) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: videoUrl ? [{ file_data: { file_uri: videoUrl } }, { text: prompt }] : [{ text: prompt }] }],
      ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens,
        thinkingConfig: { thinkingLevel: "low" },
        // Low resolution samples fewer tokens per frame, so an hour-long video still fits the context window.
        ...(videoUrl ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {})
      }
    })
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw Object.assign(new Error(`Gemini API error (${model}): ${response.status} ${detail}`), { status: response.status });
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map(part => part.text || "").join("") || "";
  const sources = [];
  const seen = new Set();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
    const uri = String(chunk?.web?.uri || "");
    if (!/^https?:\/\//.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: String(chunk.web.title || uri).slice(0, 120), uri });
    if (sources.length >= 8) break;
  }
  return { text, sources };
}

// Cron job: one batched Gemini prompt assigns categories to unanalyzed nodes and extracts edges
// between them and recently analyzed nodes. Nodes stay unprocessed (and retry tomorrow) if Gemini fails.
async function mineConnections(env) {
  if (!env.GEMINI_API_KEY) {
    console.error("Connection miner skipped: GEMINI_API_KEY is not configured.");
    return;
  }

  // One Gemini call per user, oldest backlog first, so edges never join two accounts' nodes.
  const { results: userRows } = await env.DB.prepare(
    "SELECT user_id FROM saved_nodes WHERE ai_processed_at IS NULL AND user_id IS NOT NULL GROUP BY user_id ORDER BY MIN(rowid) LIMIT ?"
  ).bind(MINER_USERS_PER_RUN).all();
  for (const { user_id: userId } of userRows || []) {
    await mineUserConnections(env, userId);
    // Synthesis layer (section 8): look for cross-topic patterns in what was just mined.
    try {
      await synthesizeForUser(env, userId);
    } catch (err) {
      console.error("Synthesis pass failed:", err);
    }
  }
}

// ---- Agentic Synthesis Engine (SPATIAL_ARCHITECTURE.md section 8) ----

// Outcome id -> input node ids for a user (or one outcome).
async function loadOutcomeInputs(env, userId, outcomeId = null) {
  const statement = outcomeId
    ? env.DB.prepare("SELECT outcome_id, node_id FROM outcome_inputs WHERE user_id = ? AND outcome_id = ?").bind(userId, outcomeId)
    : env.DB.prepare("SELECT outcome_id, node_id FROM outcome_inputs WHERE user_id = ?").bind(userId);
  const { results } = await statement.all();
  const byOutcome = new Map();
  for (const row of results || []) {
    if (!byOutcome.has(row.outcome_id)) byOutcome.set(row.outcome_id, []);
    byOutcome.get(row.outcome_id).push(row.node_id);
  }
  return byOutcome;
}

// Gold synthesis links from each outcome to the inputs it cites that are in the graph.
function buildSynthesisLinks(nodes) {
  const present = new Set(nodes.map(node => node.id));
  const links = [];
  for (const node of nodes) {
    for (const inputId of node.outcome_inputs || []) {
      if (present.has(inputId)) links.push({ source: node.id, target: inputId, value: 1, type: "synthesis" });
    }
  }
  return links;
}

// id -> { title, url } for blueprint sources.
async function loadNodeSummaries(env, userId, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { results } = await env.DB.prepare(
    `SELECT id, title, url FROM saved_nodes WHERE user_id = ? AND id IN (${ids.map(() => "?").join(", ")})`
  ).bind(userId, ...ids).all();
  (results || []).forEach(row => map.set(row.id, { title: row.title, url: row.url }));
  return map;
}

// The user's graph as the synthesis pass sees it: nodes with tags and groups, and the same links /api/graph draws.
async function loadSynthesisGraph(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, url, category, created_at, group_id, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id = ? AND NOT (category = 'outcome' AND outcome_status = 'dismissed')"
  ).bind(userId).all();
  const [tagsByNode, groups] = await Promise.all([loadNodeTags(env, userId), listGroups(env, userId)]);
  const nodes = (results || []).map(row => ({
    ...row,
    name: row.title || row.url || "",
    category: String(row.category || "note").toLowerCase(),
    created_at: toIsoTimestamp(row.created_at),
    tags: tagsByNode.get(row.id) || []
  }));
  const links = buildGraphLinks(nodes);
  links.push(...buildConceptLinks(nodes.map(node => node.id), tagsByNode, links));
  mergeMinedEdges(links, nodes, await loadMinedEdges(env, userId));
  const groupNames = new Map(groups.map(group => [group.id, group.name]));
  const familyLabel = key => key.startsWith("group:") ? (groupNames.get(key.slice(6)) || "a group")
    : key.startsWith("tag:") ? "#" + key.slice(4) : key.slice(key.indexOf(":") + 1).replace(/_/g, " ");
  return { nodes, links, familyLabel };
}

const planJson = outcome => JSON.stringify({ template: outcome.template, goal: outcome.goal, why: outcome.why, effort: outcome.effort, steps: outcome.steps });

// Finds candidate patterns and, when any qualify, asks Gemini for at most the day's remaining outcomes. Returns
// { user, candidates, created, reason? }. Nothing is written when Gemini fails or proposes nothing valid.
// The daily cron keeps to MAX_OUTCOMES_PER_DAY per user. A manual admin run ({ manual: true }) skips that limit and
// can add up to MAX_OUTCOMES_PER_DAY more each time it is pressed.
async function synthesizeForUser(env, userId, { manual = false } = {}) {
  let budget = MAX_OUTCOMES_PER_DAY;
  if (!manual) {
    const { today } = await env.DB.prepare(
      "SELECT COUNT(*) AS today FROM saved_nodes WHERE user_id = ? AND category = 'outcome' AND created_at >= datetime('now', '-1 day')"
    ).bind(userId).first();
    budget -= Number(today || 0);
    if (budget <= 0) return { user: userId, candidates: 0, created: 0, reason: "daily limit reached" };
  }

  const { nodes, links, familyLabel } = await loadSynthesisGraph(env, userId);
  const previous = [...(await loadOutcomeInputs(env, userId)).values()];
  // Connection Depth decides which links bundles may follow across groups, and how daring the plans are.
  const depth = await loadConnectionDepth(env, userId);
  const bundles = findCandidateBundles(nodes, links, { previous, depth });
  if (!bundles.length) return { user: userId, candidates: 0, created: 0, reason: "no cross-topic pattern strong enough" };

  const byId = new Map(nodes.map(node => [node.id, node]));
  const parsed = await callGeminiJson(env.GEMINI_API_KEY, buildSynthesisPrompt(bundles, byId, familyLabel, depth), 8192);
  const outcomes = parseSynthesisResponse(parsed, bundles).slice(0, budget);
  if (!outcomes.length) return { user: userId, candidates: bundles.length, created: 0, reason: "no outcome passed validation" };

  const statements = [];
  const ids = [];
  for (const outcome of outcomes) {
    const id = "node_" + crypto.randomUUID();
    ids.push(id);
    statements.push(env.DB.prepare(
      "INSERT INTO saved_nodes (id, user_id, url, title, description, category, status, outcome_status, outcome_fingerprint, outcome_plan, ai_processed_at) VALUES (?, ?, ?, ?, ?, 'outcome', 'inbox', 'proposed', ?, ?, CURRENT_TIMESTAMP)"
    ).bind(id, userId, "aether:outcome/" + id, outcome.title, outcome.why || null, outcome.fingerprint, planJson(outcome)));
    outcome.inputIds.forEach(nodeId => statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO outcome_inputs (outcome_id, node_id, user_id) VALUES (?, ?, ?)"
    ).bind(id, nodeId, userId)));
  }
  await env.DB.batch(statements);
  console.log(`Synthesis: ${bundles.length} candidate patterns, ${outcomes.length} outcomes for ${userId}.`);
  return { user: userId, candidates: bundles.length, created: outcomes.length, ids, titles: outcomes.map(outcome => outcome.title) };
}

// A fresh plan for an existing outcome from the same inputs. Returns the updated fields, or null when Gemini did not
// produce a valid plan (the old one is kept).
async function regenerateOutcome(env, userId, outcome) {
  const inputs = (await loadOutcomeInputs(env, userId, outcome.id)).get(outcome.id) || [];
  const { nodes, familyLabel } = await loadSynthesisGraph(env, userId);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ids = inputs.filter(id => byId.has(id));
  if (ids.length < 2) return null;
  const bundle = { ids, families: [...new Set(ids.map(id => topicFamily(byId.get(id))))], fingerprint: outcome.outcome_fingerprint };
  const depth = await loadConnectionDepth(env, userId);
  const parsed = await callGeminiJson(env.GEMINI_API_KEY, buildSynthesisPrompt([bundle], byId, familyLabel, depth) + "\nWrite one outcome for Bundle 0, and make it different from: " + JSON.stringify(outcome.title), 8192);
  const [fresh] = parseSynthesisResponse(parsed, [bundle]);
  if (!fresh) return null;
  await env.DB.prepare(
    "UPDATE saved_nodes SET title = ?, description = ?, outcome_plan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND category = 'outcome'"
  ).bind(fresh.title, fresh.why || null, planJson(fresh), outcome.id, userId).run();
  return { id: outcome.id, title: fresh.title, description: fresh.why || null, outcome_plan: readPlan(planJson(fresh)) };
}

async function mineUserConnections(env, userId) {
  const { results: newRows } = await env.DB.prepare(
    "SELECT id, title, url, category, group_id, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id = ? AND ai_processed_at IS NULL ORDER BY rowid LIMIT ?"
  ).bind(userId, MINER_BATCH_SIZE).all();
  if (newRows?.length) await mineNodes(env, userId, newRows, { retag: true });
}

// One Gemini call for a batch of one user's nodes. It links them to each other and to recently analyzed nodes,
// replaces their miner tags, and assigns concept groups (never over a group the user chose). retag also updates
// AI-managed categories and marks the batch analyzed (the daily run); the /api/remine backfill leaves both alone.
// Returns counts, or null when Gemini failed (nothing is written, so the batch is retried later).
async function mineNodes(env, userId, newNodes, { retag }) {
  const batchIds = new Set(newNodes.map(node => node.id));
  const { results: contextRows } = await env.DB.prepare(
    "SELECT id, title, url, category, group_id, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id = ? AND ai_processed_at IS NOT NULL AND (category IS NULL OR category != 'outcome') ORDER BY ai_processed_at DESC LIMIT ?"
  ).bind(userId, MINER_CONTEXT_SIZE + newNodes.length).all();
  const contextNodes = (contextRows || []).filter(row => !batchIds.has(row.id)).slice(0, MINER_CONTEXT_SIZE);
  const allNodes = [...newNodes, ...contextNodes];
  let groupList = [];
  try {
    groupList = await listGroups(env, userId);
  } catch (err) {
    console.error("Miner group lookup failed:", err);
  }
  const groupNames = groupList.map(group => group.name);
  // Items show their current group in the prompt, so abstract leaps can be asked for between different groups.
  const groupNameById = new Map(groupList.map(group => [group.id, group.name]));
  const describedNodes = allNodes.map(node => ({ ...node, group_name: groupNameById.get(node.group_id) || null }));
  const itemGroups = describedNodes.map(node => node.group_name);

  let mined;
  try {
    const prompt = buildMinerPrompt(describedNodes.slice(0, newNodes.length), describedNodes.slice(newNodes.length), RECLUSTER_CATEGORIES, groupNames);
    const parsed = await callGeminiJson(env.GEMINI_API_KEY, prompt, 16384);
    mined = parseMinerResponse(parsed, newNodes.length, allNodes.length, normalizeCategory, groupNames, itemGroups);
  } catch (err) {
    console.error("Connection miner Gemini call failed:", err);
    return null;
  }

  // Concept groups the batch uses, created as AI groups when they are new.
  const groupIds = new Map();
  for (const name of new Set(mined.groups.values())) {
    const group = await ensureGroup(env, userId, name, "ai");
    if (group) groupIds.set(name.toLowerCase(), group.id);
  }

  const statements = [];
  let retagged = 0;
  if (retag) {
    mined.categories.forEach((category, i) => {
      const node = newNodes[i];
      const current = String(node.category || "").toLowerCase();
      // Videos are detected from the URL; like /api/recluster, only re-tag the AI-managed categories.
      if (!RECLUSTER_CATEGORIES.includes(current) || category === current) return;
      retagged++;
      statements.push(env.DB.prepare(
        "UPDATE saved_nodes SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(category, node.id));
    });
  }
  // Each edge keeps the depth it was first found at (Connection Depth); re-mining never relabels an edge.
  for (const { a, b, relation, depth, confidence } of mined.edges) {
    const [sourceId, targetId] = [String(allNodes[a].id), String(allNodes[b].id)].sort();
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO node_edges (source_id, target_id, relation, user_id, depth, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(sourceId, targetId, relation, userId, depth, confidence));
  }
  // A node's miner tags are replaced as a set; a user tag with the same name stays a user tag.
  mined.tags.forEach((tags, i) => {
    const nodeId = newNodes[i].id;
    statements.push(env.DB.prepare("DELETE FROM node_tags WHERE node_id = ? AND user_id = ? AND source = 'miner'").bind(nodeId, userId));
    tags.forEach(({ tag, weight }) => statements.push(env.DB.prepare(
      "INSERT INTO node_tags (node_id, tag, user_id, source, weight) VALUES (?, ?, ?, 'miner', ?) ON CONFLICT (node_id, tag) DO NOTHING"
    ).bind(nodeId, tag, userId, weight)));
  });
  mined.groups.forEach((name, i) => {
    const groupId = groupIds.get(name.toLowerCase());
    if (!groupId) return;
    statements.push(env.DB.prepare(
      "UPDATE saved_nodes SET group_id = ?, group_source = 'ai' WHERE id = ? AND user_id = ? AND (group_source IS NULL OR group_source = 'ai')"
    ).bind(groupId, newNodes[i].id, userId));
  });
  if (retag) {
    statements.push(env.DB.prepare(
      `UPDATE saved_nodes SET ai_processed_at = CURRENT_TIMESTAMP WHERE id IN (${newNodes.map(() => "?").join(", ")})`
    ).bind(...newNodes.map(node => node.id)));
  }

  if (statements.length) await env.DB.batch(statements);
  const counts = { analyzed: newNodes.length, retagged, edges: mined.edges.length, tagged: mined.tags.size, grouped: mined.groups.size };
  console.log(`Connection miner: analyzed ${counts.analyzed} nodes, ${counts.retagged} re-tagged, ${counts.edges} edges, ${counts.tagged} tagged, ${counts.grouped} grouped.`);
  return counts;
}

// The user's Connection Depth; the default when it is unset or the column is missing (migration 0015 not applied).
async function loadConnectionDepth(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT connection_depth FROM users WHERE id = ?").bind(userId).first();
    return normalizeDepth(row?.connection_depth);
  } catch (err) {
    console.error("Connection depth lookup failed:", err);
    return DEFAULT_DEPTH;
  }
}

// Missing table (migration not applied yet) just means no mined edges.
async function loadMinedEdges(env, userId) {
  try {
    const { results } = await env.DB.prepare("SELECT source_id, target_id, relation, depth, confidence FROM node_edges WHERE user_id = ?").bind(userId).all();
    return results || [];
  } catch (err) {
    console.error("Mined edge lookup failed:", err);
    return [];
  }
}

// Mined edges override keyword/category links between the same pair so each pair is drawn once.
const LINK_RELATION_MAX = 80;

// node_edges is undirected and stored with source_id < target_id, so either order names the same edge.
export function normalizeEdgePair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// The pair and relationship a /api/link request names: { sourceId, targetId, relation } in stored order, or
// { error } (a 400 body). relation is the trimmed relationship, or `fallback` when it is blank.
function readLinkRequest(body, { fallback = null } = {}) {
  const source = typeof body?.source === "string" ? body.source.trim() : "";
  const target = typeof body?.target === "string" ? body.target.trim() : "";
  const relation = typeof body?.relationship === "string" && body.relationship.trim() ? body.relationship.trim() : fallback;
  if (!source || !target) return { error: "source and target are required." };
  if (source === target) return { error: "A node cannot link to itself." };
  if (relation && relation.length > LINK_RELATION_MAX) return { error: `relationship must be at most ${LINK_RELATION_MAX} characters.` };
  const [sourceId, targetId] = normalizeEdgePair(source, target);
  return { sourceId, targetId, relation };
}

// Whether the user owns both nodes.
async function ownsBothNodes(env, userId, a, b) {
  const { results } = await env.DB.prepare("SELECT id FROM saved_nodes WHERE user_id = ? AND id IN (?, ?)").bind(userId, a, b).all();
  return (results || []).length === 2;
}

const storedLink = (sourceId, targetId, relation) => ({ source: sourceId, target: targetId, value: 2, type: "ai", relation, depth: "logical", confidence: null, stored: true });

// POST /api/link: links two nodes the user owns. Linking a pair that is already linked (by hand or by the miner)
// replaces its relation with the user's. Each handler returns { status, body } for the route to send.
export async function createUserLink(env, userId, body) {
  const request = readLinkRequest(body, { fallback: "manual" });
  if (request.error) return { status: 400, body: { error: request.error } };
  const { sourceId, targetId, relation } = request;
  if (!(await ownsBothNodes(env, userId, sourceId, targetId))) return { status: 404, body: { error: "Node not found." } };

  await env.DB.prepare(
    "INSERT INTO node_edges (source_id, target_id, relation, user_id) VALUES (?, ?, ?, ?) ON CONFLICT (source_id, target_id) DO UPDATE SET relation = excluded.relation WHERE node_edges.user_id = excluded.user_id"
  ).bind(sourceId, targetId, relation, userId).run();
  return { status: 200, body: { success: true, link: storedLink(sourceId, targetId, relation) } };
}

// PATCH /api/link: relabels a stored link between two nodes the user owns (a relationship is required).
export async function updateUserLink(env, userId, body) {
  const request = readLinkRequest(body);
  if (request.error) return { status: 400, body: { error: request.error } };
  const { sourceId, targetId, relation } = request;
  if (!relation) return { status: 400, body: { error: "relationship is required." } };
  if (!(await ownsBothNodes(env, userId, sourceId, targetId))) return { status: 404, body: { error: "Node not found." } };

  const result = await env.DB.prepare(
    "UPDATE node_edges SET relation = ? WHERE source_id = ? AND target_id = ? AND user_id = ?"
  ).bind(relation, sourceId, targetId, userId).run();
  if (!result?.meta?.changes) return { status: 404, body: { error: "Link not found." } };
  return { status: 200, body: { success: true, source: sourceId, target: targetId, relation } };
}

// DELETE /api/link: removes a stored link between two nodes the user owns.
export async function deleteUserLink(env, userId, body) {
  const request = readLinkRequest(body);
  if (request.error) return { status: 400, body: { error: request.error } };
  const { sourceId, targetId } = request;
  if (!(await ownsBothNodes(env, userId, sourceId, targetId))) return { status: 404, body: { error: "Node not found." } };

  const result = await env.DB.prepare(
    "DELETE FROM node_edges WHERE source_id = ? AND target_id = ? AND user_id = ?"
  ).bind(sourceId, targetId, userId).run();
  if (!result?.meta?.changes) return { status: 404, body: { error: "Link not found." } };
  return { status: 200, body: { success: true, deleted: { source: sourceId, target: targetId } } };
}

function mergeMinedEdges(links, nodes, edges) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const linkByPair = new Map(links.map(link => [pairKey(link.source, link.target), link]));

  for (const edge of edges) {
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) continue;
    const mined = {
      source: edge.source_id,
      target: edge.target_id,
      value: 2,
      type: "ai",
      relation: edge.relation || null,
      // A node_edges row (mined, manual or tutorial): the card can relabel or delete it, unlike the computed links.
      stored: true,
      depth: normalizeDepth(edge.depth),
      confidence: Number.isFinite(Number(edge.confidence)) && edge.confidence !== null ? Number(edge.confidence) : null
    };
    const existing = linkByPair.get(pairKey(edge.source_id, edge.target_id));
    if (existing) Object.assign(existing, mined);
    else links.push(mined);
  }
}

