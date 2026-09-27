import { cleanLinkUrl, fallbackLinkTitle, fetchLinkMetadata, getYouTubeVideoId } from "./metadata.js";
import { MINER_BATCH_SIZE, MINER_CONTEXT_SIZE, buildMinerPrompt, parseMinerResponse } from "./miner.js";
import { GROUP_NAME_MAX, buildConceptLinks, ensureGroup, listGroups, loadNodeTags, normalizeGroupName, saveUserTags } from "./groups.js";
import { buildTranscriptSynopsisPrompt, buildVideoSynopsisPrompt, fetchYouTubeTranscript } from "./transcript.js";
import { WebFetchError, fetchWebContent } from "./webfetch.js";
import { SHARE_PRESET_LABELS, SHARE_TIER_LABELS, buildPresetPrompt, callClaude, parseSharePayload } from "./share.js";
import { renderSharePage } from "./share-page.js";
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

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint 0: Session auth (HttpOnly cookie) and admin-managed accounts
    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuthRoute(request, env, url);
    }

    // Endpoint 1: API returning the signed-in user's JSON graph data
    if (url.pathname === "/api/graph" && request.method === "GET") {
      const auth = await authenticateUser(request, env, url);
      if (auth.error) return auth.error;
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, title, description, category, url, created_at, research, image_url, site_name, source_url, favicon_url, user_note, status, synopsis, raw_transcript IS NOT NULL AS has_transcript, content IS NOT NULL AS has_content, group_id, group_source FROM saved_nodes WHERE user_id = ?"
        ).bind(auth.user.id).all();
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
            tags: tagsByNode.get(node.id) || []
          };
        });

        const links = buildGraphLinks(nodes);
        links.push(...buildConceptLinks(nodes.map(node => node.id), tagsByNode, links));
        mergeMinedEdges(links, nodes, await loadMinedEdges(env, auth.user.id));
        return jsonResponse({ nodes, links, groups });
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
          "SELECT rowid AS row_id, id, user_id, title, url, category, user_note, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT ?"
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
        const link = linkTargetId ? { source: id, target: linkTargetId, value: 2, type: "ai", relation: "manual" } : null;
        return jsonResponse({ success: true, node, link });
      } catch (err) {
        console.error("Node Create Error:", err);
        return jsonResponse({ error: "Create failed." }, 500);
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
        const [, , nodeResult] = await env.DB.batch([
          env.DB.prepare("DELETE FROM node_edges WHERE user_id = ? AND (source_id = ? OR target_id = ?)").bind(userId, id, id),
          env.DB.prepare("DELETE FROM node_tags WHERE user_id = ? AND node_id = ?").bind(userId, id),
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
      }
    }

    // Endpoint 5: Mobile-Optimized 3D Visualizer UI
    // NOTE: this is a template literal - avoid backslashes and ${ } in the client script below.
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
    body.collection-mode #view-toggle,
    body.collection-mode #legend { display: none !important; }
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
    /* Carousel view: one card on top of a stack, dragged or swiped sideways to page. Cards past the top one sit
       lower, smaller and fainter; the previous card waits off-screen left. Transforms are set from script. */
    .deck-view { display: flex; flex-direction: column; align-items: center; gap: 12px; overflow: hidden; padding: 6px 0 4px; }
    .deck-stage { position: relative; width: 100%; max-width: 440px; height: clamp(300px, calc(100vh - 270px), 580px); touch-action: pan-y; user-select: none; -webkit-user-select: none; }
    .item-card.carousel {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 40px;
      gap: 8px;
      /* Opaque so the cards underneath don't show through the top one. */
      background: var(--bg-panel);
      border-color: rgba(0,255,204,0.18);
      box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      transform-origin: 50% 100%;
      transition: transform 0.34s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.34s ease, border-color 0.15s ease;
      will-change: transform, opacity;
    }
    .item-card.carousel:hover, .item-card.carousel:focus-visible { background: #0e1a27; }
    .item-card.carousel.active { border-color: var(--accent); }
    .item-card.carousel.behind { pointer-events: none; }
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
    .deck-hint { font-size: 11px; color: #6b7385; }
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
    #cluster-drawer {
      position: absolute;
      top: 102px;
      right: 12px;
      bottom: 20px;
      width: 340px;
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
    /* Desktop / laptop: a floating side panel, so the graph stays visible. */
    @media (min-width: 768px) {
      #node-card { left: auto; right: 15px; top: 106px; bottom: auto; width: clamp(440px, 34vw, 480px); max-height: 80vh; }
      /* Beside an open drawer: 12px edge + 340px drawer + 16px gap; narrows on small desktops instead of
         sliding off the left edge (15px margin there). */
      body.drawer-open #node-card { right: 368px; width: min(clamp(440px, 34vw, 480px), calc(100vw - 383px)); }
    }
    @media (min-width: 1100px) {
      body.collection-mode.card-open #collection-view { padding-right: 510px; padding-bottom: 24px; }
    }
    /* Phones: a bottom sheet with a drag handle (swipe down to close, left/right to page the cluster). */
    @media (max-width: 767px) {
      #node-card { left: 6px; right: 6px; bottom: 0; max-height: 78vh; padding-top: 24px; border-radius: var(--radius-m) var(--radius-m) 0 0; border-bottom: none; }
      #node-card.dragging { transition: none; }
      #node-card.settling { transition: transform 0.2s ease; }
      .card-handle {
        display: block;
        position: absolute;
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
    /* Tablets and small laptops: icon-only Telegram and view buttons (tooltips keep the names), so the search
       box keeps its room and the top bar never scrolls. */
    @media (max-width: 900px) {
      #telegram-help-button .bar-label, #view-switch .view-label { display: none; }
      #telegram-help-button { padding: 0 10px; }
      #view-switch button { padding: 0 9px; }
    }
    @media (max-width: 600px) {
      #topbar .brand { display: none; }
      #topbar { gap: 6px; padding: 0 7px; }
      .bar-btn { padding: 0 10px; }
      .filter-dropdown { position: fixed; top: 100px; left: 10px; right: 10px; width: auto; }
      #cluster-drawer { top: auto; left: 10px; right: 10px; bottom: 12px; width: auto; max-height: 60vh; }
      #cluster-cards { flex: none; flex-direction: row; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; padding-bottom: 4px; }
      .mini-card { flex: 0 0 78%; scroll-snap-align: start; }
      body.drawer-open #node-card { right: 15px; top: 102px; bottom: auto; max-height: calc(40vh - 84px); overflow-y: auto; }
      #filter-toolbar { left: 10px; right: 10px; transform: none; max-width: none; }
      #platform-bar { flex: 1 1 auto; }
      .platform-pill { padding: 0 10px; }
      #view-switch .view-label { display: none; }
      /* Phones: short 2D/3D label, and Telegram help moves into the settings menu. */
      #telegram-help-button { display: none; }
      .settings-option.phone-only { display: block; }
      #view-toggle .bar-label { display: none; }
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
  </style>
  <!-- Pinned and self-hosted from public/vendor/ (SPATIAL_ARCHITECTURE.md, section 4.2). -->
  <script src="/vendor/3d-force-graph-1.80.0.min.js"></script>
  <script type="module" src="/js/spatial/index.js"></script>
</head>
<body>
  <header id="topbar">
    <span class="brand">Aether Portal</span>
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
    <button class="view-toggle bar-btn" id="view-toggle" data-short="2D"><span class="bar-label">2D Canvas</span></button>
    <button class="bar-btn" id="add-node-button" title="Add node" aria-label="Add node">+</button>
  <div class="settings-wrap">
    <button class="settings-button bar-btn" id="settings-toggle" title="Settings">⚙️</button>
    <div class="settings-menu" id="settings-menu">
      <button class="settings-option" id="recluster-button">⚡ Recluster Graph with AI</button>
      <button class="settings-option" id="backfill-button">🔗 Fetch Titles &amp; Previews for Old Links</button>
      <button class="settings-option" id="remine-button">🏷️ Mine Tags &amp; Groups for Old Nodes</button>
      <button class="settings-option" id="clear-filters-button">Clear Filters</button>
      <button class="settings-option phone-only" id="telegram-help-menu-option">✈️ Telegram Commands</button>
      <button class="settings-option" id="logout-button">⎋ Sign Out</button>
    </div>
  </div>
  </header>

  <!-- Second toolbar row: one segmented origin control, then the secondary filters popover at its right end. -->
  <div id="filter-toolbar">
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
    <div id="card-web" class="card-web" hidden>
      <div class="card-transcript-actions">
        <button type="button" id="card-web-button">🌐 Fetch Web Content</button>
        <button type="button" id="card-web-read" hidden>⤢ Read Web Content</button>
        <span id="card-web-status" class="card-transcript-status" aria-live="polite"></span>
      </div>
    </div>
    <p id="card-meta" class="card-meta"></p>
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

  <details id="legend" open>
    <summary class="legend-title">Categories · tap to highlight</summary>
    <div id="legend-items"></div>
  </details>

  <div id="3d-graph" style="width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;"></div>
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
      // Flat 2D canvas: nodes pinned to z = 0, camera faces the plane head-on.
      flat: false,
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
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || '{}') || {};
      if (VIEW_MODES.includes(saved.view)) filterState.view = saved.view;
      if (LIST_LAYOUTS.includes(saved.listLayout)) filterState.listLayout = saved.listLayout;
      if (LIST_SORTS.includes(saved.listSort)) filterState.listSort = saved.listSort;
      if (GROUP_BY_KEYS.includes(saved.groupBy)) filterState.groupBy = saved.groupBy;
    } catch (err) {}
    const saveViewPrefs = () => {
      try {
        localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify({ view: filterState.view, listLayout: filterState.listLayout, listSort: filterState.listSort, groupBy: filterState.groupBy }));
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
    const getCategoryColor = category => CATEGORY_COLORS[category] || FALLBACK_CATEGORY_COLOR;

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
    const getClusterLabel = key => {
      const info = clusterInfo.get(key);
      return info ? info.label : key.slice(key.indexOf(':') + 1).replace(/_/g, ' ');
    };
    const isAiCluster = key => Boolean(clusterInfo.get(key) && clusterInfo.get(key).source === 'ai');
    const getClusterColor = key => {
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
    const getCardFace = node => window.AetherSpatial.faceFromNode(node, {
      categoryColor: getBaseNodeColor(node),
      categoryLabel: getNodeCategory(node),
      group: getNodeGroup(node)
    });
    // heat: 1 focused, 0.5 hovered; dim: outside the focused neighbourhood, or filtered out by the legend or platform bar.
    const getCardTargets = node => ({
      heat: focus.node && focus.node.id === node.id ? 1 : hover.id === node.id ? 0.5 : 0,
      dim: focus.node ? (focus.nodeIds.has(node.id) ? 0 : 1) : (isHighlighted(node) ? 0 : 1)
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
      const base = link.type === 'ai' ? MINED_LINK_COLOR : DEFAULT_LINK_COLOR;
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

    // In 2D mode categories sit on a flat grid of wide rows, like a node editor canvas.
    const FLAT_COLUMNS = 4;
    const FLAT_SPACING_X = 200;
    const FLAT_SPACING_Y = 150;
    const getFlatAnchor = key => {
      const index = getClusterIndex(key);
      const rows = Math.ceil(getSlotTotal() / FLAT_COLUMNS);
      const col = index % FLAT_COLUMNS;
      const row = Math.floor(index / FLAT_COLUMNS);
      return {
        x: (col - (FLAT_COLUMNS - 1) / 2) * FLAT_SPACING_X,
        y: ((rows - 1) / 2 - row) * FLAT_SPACING_Y,
        z: 0
      };
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
      if (filterState.flat) return getFlatAnchor(key);
      const index = getClusterIndex(key);
      const total = getSlotTotal();
      const point = getSpherePoint(index, total);
      const radius = getSphereRadius(total);
      return { x: point.x * radius, y: point.y * radius, z: point.z * radius };
    };

    const clusterForce = () => {
      let nodes = [];
      const force = alpha => {
        const k = CLUSTER_STRENGTH * alpha;
        nodes.forEach(node => {
          const anchor = getClusterAnchor(getClusterKey(node));
          node.vx += (anchor.x - node.x) * k;
          node.vy += (anchor.y - node.y) * k;
          node.vz += (anchor.z - (node.z || 0)) * k;
        });
      };
      force.initialize = initNodes => { nodes = initNodes; };
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

    const matchesTimeFilter = node => {
      if (filterState.horizon === 'all') return true;
      if (!node.created_at) return true;
      const ts = new Date(node.created_at).getTime();
      if (Number.isNaN(ts)) return true;
      const diffMs = Date.now() - ts;
      const dayMs = 24 * 60 * 60 * 1000;
      switch (filterState.horizon) {
        case 'day': return diffMs <= dayMs;
        case 'week': return diffMs <= 7 * dayMs;
        case 'month': return diffMs <= 30 * dayMs;
        default: return true;
      }
    };

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
      if (!isLink && node.url && node.url !== node.title) return String(node.url);
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
      cardLink.textContent = isLink ? '🔗 Open Original Source' : '🔍 Open Full Image';
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

    const showNodeCard = node => {
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
      cardReaderButton.style.display = isLong ? 'inline-block' : 'none';

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
      if (territories.group) territories.group.visible = !focus.node && !gallery;
      syncTerritoryEmphasis();
    };

    // Each visible cluster gets a floating label (AI-suggested groups are marked with a spark). The wireframe shells are
    // gone (D5); group proxies replace them in Phase 4b.
    const territories = { group: null, entries: new Map(), visibleNodes: [] };

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
      sprite.scale.set(48, 12, 1);
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
    };

    // Labels live outside the library's picking, so a click on one arrives as a background click.
    let lastPointer = null;
    const pickLabel = () => {
      if (!THREE || !territories.group || !territories.group.visible || !lastPointer) return null;
      const rect = Graph.renderer().domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((lastPointer.x - rect.left) / rect.width) * 2 - 1,
        -((lastPointer.y - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.camera = Graph.camera();
      raycaster.setFromCamera(pointer, Graph.camera());
      const labels = [...territories.entries.values()].map(entry => entry.label).filter(label => label.visible);
      const hit = raycaster.intersectObjects(labels, false)[0];
      return hit ? hit.object.userData.cluster : null;
    };

    // Frames a bounding sphere from the current viewing direction (straight on in 2D).
    // Group state (SPATIAL_ARCHITECTURE.md 2.1): frames a cluster's bounding sphere from the current direction
    // (straight on in 2D), never closer than the node framing.
    const flyToBounds = (center, radius, cluster = null) => {
      cameraGoTo({
        target: { x: center.x, y: center.y, z: center.z },
        distance: Math.max(GROUP_MIN_DISTANCE, fitSphere(radius, 1.25)),
        ...(filterState.flat ? FLAT_ORBIT : {}),
        state: 'group',
        detail: cluster
      });
    };

    const flyToCluster = key => {
      if (gallery && gallery.key === key) {
        cameraGoTo({ ...galleryPose(gallery.yaw, (1 + GALLERY_STANDOFF) * gallery.radius), state: 'group', detail: key });
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
      if (isLink) {
        const open = document.createElement('a');
        open.href = node.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.textContent = 'Open ↗';
        open.addEventListener('click', event => event.stopPropagation());
        card.append(open);
      }
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
    // In the gallery the camera stays at the standpoint and turns to face the card, which slides forward to meet it.
    const flyToNode = node => {
      if (![node.x, node.y, node.z].every(Number.isFinite)) return;
      const cover = getCardCover();
      if (gallery && gallery.ids.has(node.id)) {
        const slot = cardField.galleryPosition(node.id);
        if (slot) {
          // The focused card grows 1.15 and slides up to 0.25 R toward the standpoint, but no closer than where it
          // still fits the part of the screen the panels leave free.
          const spatial = window.AetherSpatial;
          const yaw = spatial.yawToward(gallery.origin, slot);
          const vFov = cameraFov();
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Graph.camera().aspect);
          const freeWidth = cover && cover.side === 'right' ? 1 - Math.min(cover.fraction, 0.9) : 1;
          const freeHeight = cover && cover.side === 'bottom' ? 1 - Math.min(cover.fraction, 0.9) : 1;
          const fits = Math.max(
            (spatial.CARD_WIDTH * 1.15) / (0.8 * freeWidth * 2 * Math.tan(hFov / 2)),
            (spatial.CARD_HEIGHT * 1.15) / (0.8 * freeHeight * 2 * Math.tan(vFov / 2))
          );
          const far = (1 + GALLERY_STANDOFF) * gallery.radius;
          const slide = Math.max(0, Math.min(0.25 * gallery.radius, far - fits));
          cardField.setGallerySlide(slide);
          cameraGoTo({ ...galleryPose(yaw, far - slide), state: 'node', detail: node.id });
          return;
        }
      }
      const orbit = filterState.flat ? FLAT_ORBIT : getOrbit();
      const distance = getNodeDistance(cover);
      const point = { x: node.x, y: node.y, z: node.z };
      const target = window.AetherSpatial
        ? window.AetherSpatial.uncoveredTarget(point, { ...orbit, distance, vFov: cameraFov(), aspect: Graph.camera().aspect }, cover)
        : point;
      cameraGoTo({ target, distance, ...(filterState.flat ? FLAT_ORBIT : {}), state: 'node', detail: node.id });
    };

    // Visible nodes only, so the drawer agrees with the current filters.
    const getClusterNodes = key => Graph.graphData().nodes
      .filter(node => getClusterKey(node) === key)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    const renderClusterDrawer = () => {
      if (!drawerCluster) return;
      const nodes = getClusterNodes(drawerCluster);
      drawerCount.textContent = nodes.length + (nodes.length === 1 ? ' card' : ' cards');
      clusterCards.replaceChildren(...nodes.map(buildMiniCard));
    };

    const openClusterDrawer = key => {
      const changed = drawerCluster !== key;
      drawerCluster = key;
      drawerDot.style.background = getClusterColor(key);
      drawerTitle.textContent = (isAiCluster(key) ? '✦ ' : '') + getClusterLabel(key);
      drawerAskInput.placeholder = 'Ask Elarion about ' + getClusterLabel(key);
      if (changed) {
        drawerAskInput.value = '';
        setAskAnswer(drawerAskAnswer, '');
      }
      renderClusterDrawer();
      clusterCards.scrollTop = clusterCards.scrollLeft = 0;
      clusterDrawer.classList.add('open');
      document.body.classList.add('drawer-open');
      legend.style.display = 'none';
      if (!gallery || gallery.key !== key) {
        if (gallery) exitGallery();
        enterGallery(key);
      }
    };

    const closeClusterDrawer = () => {
      if (!clusterDrawer.classList.contains('open')) return;
      clusterDrawer.classList.remove('open');
      document.body.classList.remove('drawer-open');
      // A hidden card never fires mouseleave, so its hover is dropped here.
      if (hover.source === 'drawer') setHover(null);
      drawerCluster = null;
      if (nodeCard.style.display !== 'block') legend.style.display = 'block';
      exitGallery();
    };

    // Empty canvas resets everything: drawer, card, highlight, and the idle orbit restarts right away.
    const resetSelection = () => {
      closeClusterDrawer();
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
    const resetCameraView = () => {
      const camera = Graph.camera();
      const vFov = camera.fov * Math.PI / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
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

    const handleBackgroundClick = () => {
      const cluster = pickLabel();
      if (cluster) {
        lastBackgroundTap = null;
        flyToCluster(cluster);
        openClusterDrawer(cluster);
        return;
      }
      const now = Date.now();
      const point = lastPointer ? { x: lastPointer.x, y: lastPointer.y } : null;
      const previous = lastBackgroundTap;
      if (previous && point && previous.point && now - previous.time <= DOUBLE_TAP_MS
        && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= DOUBLE_TAP_PX) {
        lastBackgroundTap = null;
        // The first click cleared the legend highlight; a double-click only moves the camera, so restore it.
        if (previous.highlighted.size && !filterState.highlighted.size) {
          filterState.highlighted = previous.highlighted;
          applyGraphFilters();
        }
        resetCameraView();
        return;
      }
      lastBackgroundTap = { time: now, point, highlighted: new Set(filterState.highlighted) };
      resetSelection();
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
          selectNode(next, { fly: true, keepCarousel: true });
          return;
        }
      }
    };

    const selectNode = (node, options = {}) => {
      // Keep the drawer only when the node belongs to the cluster it lists.
      if (drawerCluster !== getClusterKey(node)) closeClusterDrawer();
      showNodeCard(node);
      if (!options.keepCarousel || !carousel.ids.includes(node.id)) buildCarousel(node);
      renderCarousel(node);
      setFocus(node);
      syncDrawerSelection();
      syncDeck(node);
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
        lastBackgroundTap = null;
        selectNode(node);
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
      if (nodeCard.style.display !== 'block' || cardCarousel.hidden) return;
      event.preventDefault();
      stepCarousel(event.key === 'ArrowRight' ? 1 : -1);
    });

    // Touch: drag the sheet's handle/header down to close; swipe left/right anywhere on the card to page.
    const SWIPE_DISMISS_PX = 90;
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
        closeNodeCard();
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
    const GROUP_MIN_DISTANCE = 60;
    // Focused card size on screen: about 36% of the uncovered height, and at most 80% of the uncovered width.
    const getNodeDistance = cover => {
      if (!cardField) return NODE_DISTANCE;
      const spatial = window.AetherSpatial;
      const vFov = cameraFov();
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Graph.camera().aspect);
      const freeHeight = cover && cover.side === 'bottom' ? 1 - cover.fraction : 1;
      const freeWidth = cover && cover.side === 'right' ? 1 - cover.fraction : 1;
      const grown = 1.3;
      const byHeight = (spatial.CARD_HEIGHT * grown) / (2 * Math.tan(vFov / 2) * 0.36 * Math.max(freeHeight, 0.2));
      const byWidth = (spatial.CARD_WIDTH * grown) / (2 * Math.tan(hFov / 2) * 0.8 * Math.max(freeWidth, 0.2));
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
    // Share of the canvas the open panels (node card, cluster drawer) cover: from the right on wide screens, from the
    // bottom on phones where both are sheets.
    const getCardCover = () => {
      const canvas = Graph.renderer().domElement.getBoundingClientRect();
      if (!canvas.width || !canvas.height) return null;
      const panels = [nodeCard.style.display === 'block' ? nodeCard : null, clusterDrawer.classList.contains('open') ? clusterDrawer : null]
        .filter(Boolean).map(panel => panel.getBoundingClientRect()).filter(rect => rect.width && rect.height);
      if (!panels.length) return null;
      return compactLayout.matches
        ? { side: 'bottom', fraction: Math.max(0, canvas.bottom - Math.min(...panels.map(rect => rect.top))) / canvas.height }
        : { side: 'right', fraction: Math.max(0, canvas.right - Math.min(...panels.map(rect => rect.left))) / canvas.width };
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
    // goal: { target, distance, theta?, phi?, state, detail?, instant? }; theta/phi default to the current direction.
    const cameraGoTo = goal => {
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
    graphElement.addEventListener('wheel', cancelCameraFlight, { capture: true, passive: true });

    const initCameraRig = () => {
      if (cameraRig || !window.AetherSpatial) return;
      cameraRig = new window.AetherSpatial.CameraRig({ reducedMotion: reducedMotion.matches });
      viewer = window.AetherSpatial.createViewer({ camera: Graph.camera(), controls: Graph.controls() });
      if (THREE) viewer.attachDolly(THREE, Graph.scene());
    };
    if (window.AetherSpatial) initCameraRig();
    else window.addEventListener('aether-spatial-ready', initCameraRig, { once: true });

    // Card field: built once three.js and the spatial modules are both in. The field places every card each frame from
    // the simulated node positions (plus gallery and focus offsets), so the graph's own position writes are skipped.
    let cardFrame = 0;
    let cardLastTime = 0;
    const cardLoop = time => {
      const dt = cardLastTime ? (time - cardLastTime) / 1000 : 1 / 60;
      cardLastTime = time;
      if (filterState.view === 'graph') cardField.frame(dt, Graph.camera());
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
      Graph.d3ReheatSimulation();
      if (!cardFrame) cardFrame = requestAnimationFrame(cardLoop);
    };
    window.addEventListener('aether-spatial-ready', initCards, { once: true });

    // ---- 180-degree gallery (SPATIAL_ARCHITECTURE.md 6): opening a group in 3D lays its cards on a half cylinder around
    // a standpoint at the cluster's centre. On screens the camera stands 0.35 R behind that point and dragging turns
    // the view along the wall (polar angle locked to the horizon, no pan or zoom). ----
    let savedControls = null;
    const GALLERY_STANDOFF = 0.35;
    const lockGalleryControls = on => {
      const controls = Graph.controls();
      if (on && !savedControls) {
        savedControls = { min: controls.minPolarAngle, max: controls.maxPolarAngle, zoom: controls.enableZoom, pan: controls.enablePan };
        controls.minPolarAngle = Math.PI / 2;
        controls.maxPolarAngle = Math.PI / 2;
        controls.enableZoom = false;
        controls.enablePan = false;
      } else if (!on && savedControls) {
        controls.minPolarAngle = savedControls.min;
        controls.maxPolarAngle = savedControls.max;
        controls.enableZoom = savedControls.zoom;
        controls.enablePan = savedControls.pan;
        savedControls = null;
      }
    };
    // Camera pose in the gallery: at the standpoint, level, facing yaw. Open panels are cleared without moving the
    // pivot the drag turns around: a right-hand panel turns the view so what it faces sits mid-way across the free
    // part of the screen; bottom sheets lower the eye so it sits mid-way up the free part. lookDistance is how far
    // away the thing being looked at is.
    const galleryPose = (yaw, lookDistance) => {
      const cover = getCardCover();
      const fraction = cover ? Math.min(cover.fraction, 0.9) : 0;
      const vFov = cameraFov();
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Graph.camera().aspect);
      const turn = cover && cover.side === 'right' ? Math.atan(fraction * Math.tan(hFov / 2)) : 0;
      const drop = cover && cover.side === 'bottom' ? fraction * lookDistance * Math.tan(vFov / 2) : 0;
      return {
        target: { x: gallery.origin.x, y: gallery.origin.y - drop, z: gallery.origin.z },
        distance: GALLERY_STANDOFF * gallery.radius,
        theta: -(yaw + turn),
        phi: Math.PI / 2
      };
    };
    const galleryIds = key => getClusterNodes(key).filter(node => Number.isFinite(node.x)).map(node => node.id);
    const enterGallery = key => {
      if (!cardField || filterState.flat || filterState.view !== 'graph') return;
      const entry = territories.entries.get(key);
      const ids = galleryIds(key);
      if (!entry || !entry.center || !ids.length) return;
      const origin = { ...entry.center };
      const camera = Graph.camera().position;
      const yaw = window.AetherSpatial.yawToward(camera, origin);
      const placed = cardField.enterGallery(ids, { origin, yaw });
      gallery = { key, origin, yaw, radius: placed.radius, ids: placed.ids };
      Graph.linkVisibility(link => !gallery || !(gallery.ids.has(linkEndId(link.source)) || gallery.ids.has(linkEndId(link.target))));
      if (territories.group) territories.group.visible = false;
      pauseAutoRotate();
      lockGalleryControls(true);
      // Camera 0.35 R behind the standpoint, level, looking along the gallery's facing.
      cameraGoTo({ ...galleryPose(yaw, (1 + GALLERY_STANDOFF) * placed.radius), state: 'group', detail: key });
    };
    // Filters or group changes while the gallery is open re-slot its cards without moving the camera.
    const refreshGallery = () => {
      if (!gallery) return;
      const ids = galleryIds(gallery.key);
      if (!ids.length) {
        exitGallery();
        return;
      }
      const placed = cardField.enterGallery(ids, { origin: gallery.origin, yaw: gallery.yaw });
      gallery.ids = placed.ids;
      gallery.radius = placed.radius;
    };
    const exitGallery = () => {
      if (!gallery) return;
      const key = gallery.key;
      gallery = null;
      cardField.exitGallery();
      Graph.linkVisibility(true);
      lockGalleryControls(false);
      if (territories.group) territories.group.visible = !focus.node;
      if (filterState.view === 'graph') flyToCluster(key);
    };

    // Closing the card steps back out from Node to the node's cluster (Group state).
    const closeNodeCard = () => {
      const node = focus.node;
      const wasFocused = Boolean(cameraRig && cameraRig.state === 'node');
      hideNodeCard();
      if (node && wasFocused && filterState.view === 'graph') flyToCluster(getClusterKey(node));
    };

    // A filter change reframes what is left once it has had a moment to settle (typing debounces through scheduleFit).
    const reframeAfterFilter = () => {
      if (filterState.view === 'graph' && !focus.node) scheduleFit(400);
    };

    import('/vendor/three-0.180.0/three.module.js')
      .then(module => {
        THREE = module;
        if (viewer) viewer.attachDolly(THREE, Graph.scene());
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
    };

    const renderLegend = visibleNodes => {
      const counts = new Map();
      visibleNodes.forEach(node => {
        const category = getNodeCategory(node);
        counts.set(category, (counts.get(category) || 0) + 1);
      });
      // Keep highlighted categories listed (at 0) so they can still be toggled off.
      filterState.highlighted.forEach(category => { if (!counts.has(category)) counts.set(category, 0); });

      const rank = category => {
        const index = CATEGORY_ORDER.indexOf(category);
        return index >= 0 ? index : CATEGORY_ORDER.length;
      };
      const categories = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

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
          if (!highlighting || filterState.view !== 'graph') return;
          cancelPendingFit();
          flyToCategory(category);
        });
        return item;
      }));
      legend.style.visibility = categories.length ? 'visible' : 'hidden';
    };

    const applyGraphFilters = () => {
      let filteredNodes = graphData.nodes.filter(node => matchesTypeFilter(node) && matchesTimeFilter(node) && matchesSearch(node));
      let visibleIds = new Set(filteredNodes.map(node => node.id));
      const filteredLinks = graphData.links.filter(link => visibleIds.has(linkEndId(link.source)) && visibleIds.has(linkEndId(link.target)));

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
      if (cardField) cardField.retain(visibleIds);
      refreshGallery();
      renderActiveView();
    };

    const loadGraph = async () => {
      const res = await fetch('/api/graph');
      if (res.status === 401) {
        showLoginGate();
        return;
      }
      if (!res.ok) throw new Error('Graph request failed: ' + res.status);
      graphData = normalizeGraphData(await res.json());
      graphLoaded = true;
      pinToPlane(graphData.nodes);
      applyGraphFilters();
      // First load in graph view: the layout grows out from the origin, so frame it once it has spread.
      if (filterState.view === 'graph') scheduleFit(FIT_SETTLE_MS + 600);
      if (deepLinkId) openDeepLink();
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
      // The layout has no positions yet on first load; fly once it has spread, if the card is still open.
      setTimeout(() => {
        if (focus.node === node && filterState.view === 'graph') flyToNode(node);
      }, FIT_SETTLE_MS);
    };

    // fz is honored by the d3 simulation; null releases the node back into 3D.
    const pinToPlane = nodes => {
      nodes.forEach(node => {
        if (filterState.flat) {
          node.fz = 0;
          node.z = 0;
          node.vz = 0;
        } else {
          node.fz = null;
          // Leaving the flat canvas every z is 0; a small nudge lets repulsion work in depth again.
          if (node.z === 0) node.z = (Math.random() - 0.5) * 10;
        }
      });
    };

    const viewToggle = document.getElementById('view-toggle');
    viewToggle.addEventListener('click', () => {
      if (gallery) closeClusterDrawer();
      filterState.flat = !filterState.flat;
      viewToggle.querySelector('.bar-label').textContent = filterState.flat ? '3D Graph' : '2D Canvas';
      viewToggle.dataset.short = filterState.flat ? '3D' : '2D';
      viewToggle.classList.toggle('active', filterState.flat);
      pinToPlane(graphData.nodes);

      const controls = Graph.controls();
      // Trackball controls (the default) use noRotate; orbit controls use enableRotate.
      controls.noRotate = filterState.flat;
      controls.enableRotate = !filterState.flat;
      // In 2D, left-drag pans instead of rotating (THREE.MOUSE: 0 = rotate, 2 = pan).
      if (controls.mouseButtons) controls.mouseButtons.LEFT = filterState.flat ? 2 : 0;
      // Same for one-finger touch, which would otherwise do nothing with rotation off (THREE.TOUCH: 0 = rotate, 1 = pan).
      if (controls.touches) controls.touches.ONE = filterState.flat ? 1 : 0;

      pauseAutoRotate();
      Graph.d3ReheatSimulation();
      // resetCameraView squares the camera up (no roll left over from 3D) and fits what is there now;
      // the second fit frames the layout after it has moved onto the plane or back into depth.
      resetCameraView();
      scheduleFit();
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
    const apiFetch = async (path, options) => {
      const res = await fetch(path, options);
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
      setAskAnswer(output, 'Elarion is thinking…');
      try {
        const body = await apiFetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, label, focusId, nodeIds: nodeIds.slice(0, ASK_MAX_NODES) })
        });
        setAskAnswer(output, formatAnswer(body.answer, body.sources));
        return { ...body, question };
      } catch (err) {
        setAskAnswer(output, err.message || 'Elarion could not answer.', true);
        return null;
      } finally {
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

    const showReader = (title, meta, body) => {
      readerTitle.textContent = title;
      readerMeta.textContent = meta;
      readerBody.textContent = body;
      if (cardLink.getAttribute('href')) {
        readerLink.href = cardLink.href;
        readerLink.style.display = 'inline-block';
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
      showReader(
        cardTitle.textContent,
        [cardTag.textContent, site, cardMeta.textContent].filter(Boolean).join(' · '),
        [note ? '📝 Your note' + NEWLINE + note : '', cardDescription.textContent].filter(Boolean).join(NEWLINE + NEWLINE)
      );
    };
    const closeReader = () => { readerModal.hidden = true; };
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
      node.z = filterState.flat ? 0 : anchor.z + jitter();
      if (filterState.flat) node.fz = 0;
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
        // Let the simulation settle the node briefly before framing it.
        setTimeout(() => {
          const live = Graph.graphData().nodes.find(item => item.id === node.id);
          if (live) selectNode(live, { fly: true });
        }, 600);
      } catch (err) {
        console.error('Create failed:', err);
        addNodeError.textContent = err.message || 'Create failed.';
      } finally {
        addNodeSubmit.disabled = false;
        addNodeSubmit.textContent = 'Create Node';
      }
    });

    // Pages through an admin batch endpoint (POST ?cursor=N) until it reports done.
    const runAdminBatches = async ({ button, path, busyLabel, summarize }) => {
      const token = getAdminToken();
      if (!token) return;

      const idleLabel = button.textContent;
      button.disabled = true;
      let processed = 0;
      let updated = 0;
      let cursor = 0;
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
          processed += body.processed || 0;
          updated += body.updated || 0;
          if (body.done || body.nextCursor === cursor) break;
          cursor = body.nextCursor;
        }
        await loadGraph();
        alert(summarize(updated, processed));
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
        const open = document.createElement('a');
        open.href = node.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.textContent = 'Open ↗';
        open.addEventListener('click', event => event.stopPropagation());
        foot.append(site, open);
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

    // Carousel view: the visible nodes (in the list sort) as a card deck. deck.id is the top card and survives
    // re-renders and view changes, so the deck reopens where it was, or on the node selected in the graph.
    const DECK_BEHIND = 3;
    const DECK_STEP_PX = 12;
    const DECK_SCALE_STEP = 0.05;
    const DECK_FADE_STEP = 0.18;
    const DECK_TILT_DEG = 8;
    const DECK_DRAG_START_PX = 8;
    const DECK_COMMIT_SHARE = 0.25;
    const DECK_FLICK_PX = 30;
    const DECK_FLICK_SPEED = 0.45;
    const DECK_CLICK_GUARD_MS = 400;
    const deck = { nodes: [], index: 0, id: null, cards: new Map(), stage: null, counter: null, prev: null, next: null, throwX: 0, suppressClickUntil: 0 };
    let deckDrag = null;

    // depth 0 is the top card, 1..DECK_BEHIND the stack under it, DECK_BEHIND + 1 an invisible slot at the back;
    // fractional depths are used mid-drag. x slides a card sideways and tilts it with the distance.
    const placeDeckCard = (card, depth, x) => {
      const width = deck.stage.clientWidth || 1;
      const opacity = depth <= DECK_BEHIND ? 1 - DECK_FADE_STEP * depth : (1 - DECK_FADE_STEP * DECK_BEHIND) * Math.max(0, DECK_BEHIND + 1 - depth);
      card.style.transform = 'translate(' + x + 'px, ' + (depth * DECK_STEP_PX) + 'px) rotate(' + (x / width * DECK_TILT_DEG) + 'deg) scale(' + (1 - DECK_SCALE_STEP * depth) + ')';
      card.style.opacity = String(opacity);
    };

    const layoutDeck = () => {
      if (!deck.stage || !deck.stage.isConnected) return;
      // Far enough left that a card with the previous offset is fully off-screen.
      deck.throwX = deck.stage.getBoundingClientRect().right + 24;
      const wanted = new Map();
      for (let offset = -1; offset <= DECK_BEHIND + 1; offset++) {
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
        card.tabIndex = offset === 0 ? 0 : -1;
        card.setAttribute('aria-hidden', String(offset !== 0));
        // The previous card sits above the stack so it slides back in over the top one.
        card.style.zIndex = String(offset < 0 ? 20 : 10 - offset);
        if (offset < 0) placeDeckCard(card, 0, -deck.throwX);
        else placeDeckCard(card, offset, 0);
      });
      deck.counter.textContent = (deck.index + 1) + ' / ' + deck.nodes.length;
      deck.prev.disabled = deck.index <= 0;
      deck.next.disabled = deck.index >= deck.nodes.length - 1;
    };

    // Mid-drag: left pulls the top card with the finger and lifts the stack; right slides the previous card
    // back in and pushes the stack down. Past either end the top card only gives a little.
    const dragDeck = dx => {
      const atEnd = dx < 0 ? deck.index >= deck.nodes.length - 1 : deck.index <= 0;
      const progress = Math.min(Math.abs(dx) / (deck.stage.clientWidth || 1), 1);
      deck.cards.forEach(card => {
        const offset = Number(card.dataset.offset);
        if (atEnd) {
          if (offset === 0) placeDeckCard(card, 0, dx * 0.25);
        } else if (dx < 0) {
          if (offset === 0) placeDeckCard(card, 0, dx);
          else if (offset > 0) placeDeckCard(card, offset - progress, 0);
        } else if (offset < 0) {
          placeDeckCard(card, 0, -deck.throwX * (1 - progress));
        } else {
          placeDeckCard(card, offset + progress, 0);
        }
      });
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
      if (!drag.active) return;
      deck.stage.classList.remove('dragging');
      deck.suppressClickUntil = performance.now() + DECK_CLICK_GUARD_MS;
      const flick = Math.abs(drag.dx) > DECK_FLICK_PX && Math.abs(drag.speed) > DECK_FLICK_SPEED && Math.sign(drag.speed) === Math.sign(drag.dx);
      if (!cancelled && (flick || Math.abs(drag.dx) > deck.stage.clientWidth * DECK_COMMIT_SHARE)) stepDeck(drag.dx < 0 ? 1 : -1);
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
      hint.textContent = 'Swipe or use ← → · tap the card for details';
      view.append(stage, controls, hint);
      Object.assign(deck, { stage, counter, prev, next });

      // A sideways drag pages the deck; a mostly vertical one is left to the page scroll (touch-action: pan-y).
      stage.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        deckDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, speed: 0, lastX: event.clientX, lastTime: event.timeStamp, active: false };
      });
      stage.addEventListener('pointermove', event => {
        if (!deckDrag || event.pointerId !== deckDrag.pointerId) return;
        const dx = event.clientX - deckDrag.x;
        const dy = event.clientY - deckDrag.y;
        if (!deckDrag.active) {
          if (Math.abs(dy) > DECK_DRAG_START_PX && Math.abs(dy) > Math.abs(dx)) {
            deckDrag = null;
            return;
          }
          if (Math.abs(dx) < DECK_DRAG_START_PX) return;
          deckDrag.active = true;
          stage.setPointerCapture(event.pointerId);
          stage.classList.add('dragging');
        }
        const elapsed = event.timeStamp - deckDrag.lastTime;
        if (elapsed > 0) deckDrag.speed = (event.clientX - deckDrag.lastX) / elapsed;
        deckDrag.lastX = event.clientX;
        deckDrag.lastTime = event.timeStamp;
        deckDrag.dx = dx;
        dragDeck(dx);
      });
      stage.addEventListener('pointerup', event => endDeckDrag(event, false));
      stage.addEventListener('pointercancel', event => endDeckDrag(event, true));
      stage.addEventListener('dragstart', event => event.preventDefault());
      // A drag that ends over the card must not also open it or follow its link.
      stage.addEventListener('click', event => {
        if (performance.now() >= deck.suppressClickUntil) return;
        event.preventDefault();
        event.stopPropagation();
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

    const renderCollection = () => {
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
      googleSignin.focus();
      startOneTap();
    }

    // Reloading after sign-out drops every in-memory node; the empty session then shows the gate.
    document.getElementById('logout-button').addEventListener('click', async () => {
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
      headers: { "Content-Type": "text/html;charset=UTF-8" }
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
    return jsonResponse({ user: { id: user.id, username: user.username, email: user.email || null, tier: user.tier || "free" } });
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
  }
}

async function mineUserConnections(env, userId) {
  const { results: newRows } = await env.DB.prepare(
    "SELECT id, title, url, category, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id = ? AND ai_processed_at IS NULL ORDER BY rowid LIMIT ?"
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
    "SELECT id, title, url, category, COALESCE(synopsis, substr(content, 1, 300)) AS snippet FROM saved_nodes WHERE user_id = ? AND ai_processed_at IS NOT NULL ORDER BY ai_processed_at DESC LIMIT ?"
  ).bind(userId, MINER_CONTEXT_SIZE + newNodes.length).all();
  const contextNodes = (contextRows || []).filter(row => !batchIds.has(row.id)).slice(0, MINER_CONTEXT_SIZE);
  const allNodes = [...newNodes, ...contextNodes];
  let groupNames = [];
  try {
    groupNames = (await listGroups(env, userId)).map(group => group.name);
  } catch (err) {
    console.error("Miner group lookup failed:", err);
  }

  let mined;
  try {
    const prompt = buildMinerPrompt(newNodes, contextNodes, RECLUSTER_CATEGORIES, groupNames);
    const parsed = await callGeminiJson(env.GEMINI_API_KEY, prompt, 16384);
    mined = parseMinerResponse(parsed, newNodes.length, allNodes.length, normalizeCategory, groupNames);
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
  for (const { a, b, relation } of mined.edges) {
    const [sourceId, targetId] = [String(allNodes[a].id), String(allNodes[b].id)].sort();
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO node_edges (source_id, target_id, relation, user_id) VALUES (?, ?, ?, ?)"
    ).bind(sourceId, targetId, relation, userId));
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

// Missing table (migration not applied yet) just means no mined edges.
async function loadMinedEdges(env, userId) {
  try {
    const { results } = await env.DB.prepare("SELECT source_id, target_id, relation FROM node_edges WHERE user_id = ?").bind(userId).all();
    return results || [];
  } catch (err) {
    console.error("Mined edge lookup failed:", err);
    return [];
  }
}

// Mined edges override keyword/category links between the same pair so each pair is drawn once.
function mergeMinedEdges(links, nodes, edges) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const linkByPair = new Map(links.map(link => [pairKey(link.source, link.target), link]));

  for (const edge of edges) {
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) continue;
    const mined = { source: edge.source_id, target: edge.target_id, value: 2, type: "ai", relation: edge.relation || null };
    const existing = linkByPair.get(pairKey(edge.source_id, edge.target_id));
    if (existing) Object.assign(existing, mined);
    else links.push(mined);
  }
}

