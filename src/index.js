import { fetchLinkMetadata } from "./metadata.js";
import { MINER_BATCH_SIZE, MINER_CONTEXT_SIZE, buildMinerPrompt, parseMinerResponse } from "./miner.js";

const VIDEO_URL_PATTERN = /(youtube\.com|youtu\.be|facebook\.com\/(reel|watch)|fb\.watch|instagram\.com\/(reel|tv)|tiktok\.com|vimeo\.com|x\.com\/i\/status|twitter\.com\/i\/status|\.mp4(\?|$)|\.webm(\?|$)|\.mov(\?|$)|\.m4v(\?|$))/i;

const VALID_CATEGORIES = ["note", "link", "article", "dev_task", "monetization", "ai_tool", "marketing", "route_plan", "general", "video"];
const RECLUSTER_CATEGORIES = ["note", "general", "link", "article", "dev_task", "monetization", "ai_tool", "marketing", "route_plan"];

// Keeps each recluster request well under the Workers subrequest / D1 query limits:
// per node at most 1 context lookup + 1 Gemini call + 1 update.
const RECLUSTER_BATCH_SIZE = 10;
// One metadata fetch (4 s timeout) + one update per link.
const METADATA_BACKFILL_BATCH_SIZE = 10;
const MAX_SEMANTIC_LINKS_PER_NODE = 5;
// gemini-2.5-flash started returning 404 in July 2026; 3.x Flash models replace it.
// Tried in order: a model answering 503 (high demand) or 429 falls through to the next.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"];
const GEMINI_RETRYABLE_STATUSES = [429, 503];

const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with", "is", "https", "http", "com", "www"]);

export default {
  // Daily cron (wrangler.jsonc triggers): categorize unanalyzed nodes and mine relationship edges.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(mineConnections(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint 1: API returning JSON graph data
    if (url.pathname === "/api/graph" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, title, description, category, url, created_at FROM saved_nodes"
        ).all();

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
            created_at: toIsoTimestamp(node.created_at)
          };
        });

        const links = buildGraphLinks(nodes);
        mergeMinedEdges(links, nodes, await loadMinedEdges(env));
        return jsonResponse({ nodes, links });
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
          "SELECT rowid AS row_id, id, title, url, category, created_at FROM saved_nodes WHERE ai_processed_at IS NULL AND rowid > ? ORDER BY rowid LIMIT ?"
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
          "SELECT rowid AS row_id, id, url FROM saved_nodes WHERE (title = url OR description IS NULL) AND (url LIKE 'http://%' OR url LIKE 'https://%') AND rowid > ? ORDER BY rowid LIMIT ?"
        ).bind(cursor, METADATA_BACKFILL_BATCH_SIZE).all();

        const nodes = results || [];
        const fetched = await Promise.all(nodes.map(node => fetchLinkMetadata(String(node.url).split(/\s+/)[0])));
        const updates = [];
        nodes.forEach((node, i) => {
          const metadata = fetched[i];
          if (!metadata) return;
          updates.push(env.DB.prepare(
            "UPDATE saved_nodes SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(metadata.title, metadata.description, node.id));
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

    // Endpoint 4: Telegram Webhook POST
    if (request.method === "POST") {
      if (url.pathname !== "/") {
        return new Response("Not found", { status: 404 });
      }
      if (!isAuthorizedTelegram(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await request.json();
        const chatId = update.message?.chat?.id;
        let text = String(update.message?.text || "").trim();

        if (!chatId) return new Response("OK");

        const token = env.TELEGRAM_TOKEN;
        if (!text) {
          await sendTelegram(token, chatId, "Only text messages and links can be saved right now.");
          return new Response("OK");
        }

        const id = "node_" + crypto.randomUUID();
        let extractedTitle = text.length > 30 ? text.slice(0, 30) + "..." : text;
        let description = null;

        let category = "note";
        if (text.startsWith("http://") || text.startsWith("https://")) {
          category = inferNodeCategory(text, "link");
          const metadata = await fetchLinkMetadata(text.split(/\s+/)[0]);
          if (metadata) {
            extractedTitle = metadata.title;
            description = metadata.description;
          }
        } else if (text.length > 100) {
          category = "article";
        }

        if (isGenericPlaceholder(text)) {
          const contextualLink = await findRecentLinkContext(env, null, id);
          if (contextualLink) {
            const mergedText = [text, contextualLink.title, contextualLink.url].filter(Boolean).join(" | ");
            const analysis = env.GEMINI_API_KEY ? await analyzeWithGemini(env.GEMINI_API_KEY, mergedText, category) : null;
            if (analysis) {
              category = normalizeCategory(analysis.category, category);
              extractedTitle = analysis.title;
            } else {
              extractedTitle = String(contextualLink.title || extractedTitle);
            }
            description = contextualLink.description || null;
            text = String(contextualLink.url || text);
          }
        }

        await env.DB.prepare(
          "INSERT INTO saved_nodes (id, url, title, description, category) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, text, extractedTitle, description, category).run();

        await sendTelegram(
          token,
          chatId,
          `🌌 Received! Stashed into the Aether Portal for Elarion to inspect with our big brain.\n🧠 Saved as [${category.toUpperCase()}]: "${extractedTitle}"`
        );
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
  <style>
    body { margin: 0; overflow: hidden; background-color: #080c14; font-family: system-ui, -apple-system, sans-serif; touch-action: none; }
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
      border-radius: 14px;
      background: rgba(8, 12, 20, 0.6);
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    #topbar .brand { color: #00ffcc; font-size: 14px; font-weight: 600; white-space: nowrap; }
    #topbar .bar-spacer { flex: 1; }
    .bar-btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      height: 30px;
      box-sizing: border-box;
      padding: 0 12px;
      border: 1px solid rgba(0,255,204,0.35);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: #dffdf7;
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
      border: 1px solid rgba(0,255,204,0.25);
      background: rgba(255,255,255,0.04);
      color: #00ffcc;
      border-radius: 999px;
      padding: 0 12px;
      font-size: 12px;
      outline: none;
    }
    #search-input::placeholder { color: rgba(0,255,204,0.4); }
    #filter-menu { position: relative; }
    #filter-menu summary { list-style: none; }
    #filter-menu summary::-webkit-details-marker { display: none; }
    #filter-menu[open] summary { background: rgba(0,255,204,0.18); border-color: rgba(0,255,204,0.6); }
    .filter-dropdown {
      position: absolute;
      top: 40px;
      left: 0;
      min-width: 300px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border-radius: 12px;
      background: rgba(9, 15, 25, 0.96);
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 18px 40px rgba(0,0,0,0.35);
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-pill, .toggle-button, #time-filter {
      appearance: none;
      border: 1px solid rgba(0,255,204,0.25);
      background: rgba(255,255,255,0.04);
      color: #dffdf7;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .filter-pill.active, .toggle-button.active {
      background: linear-gradient(135deg, rgba(0,255,204,0.3), rgba(79,132,255,0.3));
      border-color: rgba(0,255,204,0.65);
      color: #ffffff;
    }
    #time-filter {
      min-width: 132px;
      color: #dffdf7;
    }
    .toggle-button {
      font-weight: 600;
    }
    .settings-wrap { position: relative; }
    .view-toggle.active { background: rgba(0,255,204,0.18); border-color: rgba(0,255,204,0.6); }
    .settings-menu {
      position: absolute;
      right: 0;
      top: 40px;
      width: 220px;
      background: rgba(9, 15, 25, 0.96);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 10px;
      display: none;
      box-shadow: 0 18px 40px rgba(0,0,0,0.35);
    }
    .settings-menu.open {
      display: block;
    }
    .settings-option {
      width: 100%;
      border: 1px solid rgba(0,255,204,0.2);
      background: rgba(255,255,255,0.03);
      color: #fff;
      border-radius: 10px;
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
      color: #fff;
      z-index: 10;
      background: rgba(8, 12, 20, 0.92);
      padding: 16px 20px;
      border-radius: 14px;
      border: 1px solid rgba(0, 255, 204, 0.3);
      display: none;
      backdrop-filter: blur(12px);
      box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    }
    #node-card .card-close {
      position: absolute;
      top: 8px;
      right: 10px;
      background: none;
      border: none;
      color: #8a93a6;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
    }
    #node-card .card-close:hover { color: #00ffcc; }
    #node-card h3 { padding-right: 24px; margin: 0 0 6px 0; font-size: 15px; color: #00ffcc; line-height: 1.3; }
    #node-card p { margin: 0 0 12px 0; font-size: 13px; color: #ccc; word-break: break-word; line-height: 1.4; }
    #node-card .card-tag {
      display: inline-block;
      margin-bottom: 8px;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid rgba(0,255,204,0.45);
      background: rgba(0,255,204,0.1);
      color: #00ffcc;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    #node-card .card-meta { font-size: 11px; color: #8a93a6; }
    #node-card a {
      display: inline-block;
      background: #00ffcc;
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
      border-radius: 12px;
      background: rgba(8, 12, 20, 0.55);
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
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
      border-radius: 8px;
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
    @media (max-width: 600px) {
      #topbar .brand { display: none; }
      #topbar { gap: 6px; padding: 0 7px; }
      .bar-btn { padding: 0 10px; }
      #filter-menu { position: static; }
      .filter-dropdown { top: 50px; left: 0; right: 0; min-width: 0; }
    }
  </style>
  <script src="https://unpkg.com/3d-force-graph@1.80.0/dist/3d-force-graph.min.js"></script>
</head>
<body>
  <header id="topbar">
    <span class="brand">Aether Portal</span>
    <input type="text" id="search-input" placeholder="🔍 Search nodes...">
    <details id="filter-menu">
      <summary class="bar-btn">Filter ▾</summary>
      <div class="filter-dropdown">
    <div class="filter-row" id="type-filters">
      <button class="filter-pill active" data-filter="all">All</button>
      <button class="filter-pill" data-filter="link">Links</button>
      <button class="filter-pill" data-filter="dev_task">Dev Tasks</button>
      <button class="filter-pill" data-filter="video">Videos</button>
      <button class="filter-pill" data-filter="note">Notes</button>
    </div>
    <div class="filter-row">
      <select id="time-filter">
        <option value="all">All Time</option>
        <option value="day">Today</option>
        <option value="week">Last 7 Days</option>
        <option value="month">Last 30 Days</option>
      </select>
      <button id="cluster-toggle" class="toggle-button active" data-mode="category">Category View</button>
    </div>
      </div>
    </details>
    <span class="bar-spacer"></span>
    <button class="view-toggle bar-btn" id="view-toggle">2D Canvas</button>
  <div class="settings-wrap">
    <button class="settings-button bar-btn" id="settings-toggle" title="Settings">⚙️</button>
    <div class="settings-menu" id="settings-menu">
      <button class="settings-option" id="recluster-button">⚡ Recluster Graph with AI</button>
      <button class="settings-option" id="backfill-button">🔗 Fetch Titles for Old Links</button>
      <button class="settings-option" id="clear-filters-button">Clear Filters</button>
    </div>
  </div>
  </header>

  <div id="node-card">
    <button id="card-close" class="card-close" title="Close" aria-label="Close">×</button>
    <span id="card-tag" class="card-tag">NOTE</span>
    <h3 id="card-title">Node Details</h3>
    <p id="card-description"></p>
    <p id="card-meta" class="card-meta"></p>
    <a id="card-link" href="#" target="_blank" rel="noopener noreferrer">Open Link ↗</a>
  </div>

  <details id="legend" open>
    <summary class="legend-title">Categories · tap to highlight</summary>
    <div id="legend-items"></div>
  </details>

  <div id="3d-graph" style="width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;"></div>

  <script>
    const ADMIN_TOKEN_KEY = 'aetherAdminToken';

    const filterState = {
      type: 'all',
      horizon: 'all',
      query: '',
      clusterMode: 'category',
      // Flat 2D canvas: nodes pinned to z = 0, camera faces the plane head-on.
      flat: false,
      // Categories highlighted from the legend; empty means everything is shown at full color.
      highlighted: new Set()
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
      route_plan: '#f15bb5'
    };
    const CATEGORY_ORDER = Object.keys(CATEGORY_COLORS);
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

    const isHighlighted = node => filterState.highlighted.size === 0 || filterState.highlighted.has(getNodeCategory(node));

    // Selecting a node focuses its 1-hop neighborhood: everything else fades to FOCUS_DIM_OPACITY.
    const FOCUS_DIM_OPACITY = 0.15;
    const BASE_NODE_OPACITY = 0.75;
    const BASE_LINK_OPACITY = 0.2;
    const focus = { node: null, nodeIds: new Set(), links: new Set() };

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
    const HARDWARE_PATTERN = /3d.?print|printer|filament|hardware|arduino|raspberry|esp32|thingiverse|printables|makerworld|cnc|solder|pcb/i;
    const CONE_CATEGORIES = ['video', 'marketing'];
    const CYLINDER_CATEGORIES = ['note', 'general', 'dev_task', 'route_plan'];

    const getNodeShape = node => {
      if (HARDWARE_PATTERN.test(String(node.title || '') + ' ' + String(node.url || ''))) return 'box';
      const category = getNodeCategory(node);
      if (CONE_CATEGORIES.includes(category)) return 'cone';
      if (CYLINDER_CATEGORIES.includes(category)) return 'cylinder';
      return 'sphere';
    };

    const geometryCache = new Map();
    const getShapeGeometry = shape => {
      if (!geometryCache.has(shape)) {
        const geometry = shape === 'box' ? new THREE.BoxGeometry(6.5, 6.5, 6.5)
          : shape === 'cone' ? new THREE.ConeGeometry(5, 8, 4)
          : shape === 'cylinder' ? new THREE.CylinderGeometry(3.5, 3.5, 7, 16)
          : new THREE.SphereGeometry(4, 16, 12);
        geometryCache.set(shape, geometry);
      }
      return geometryCache.get(shape);
    };

    // Splits rgba()/hsla() into an opaque color plus its alpha; three.js materials take opacity separately.
    const splitColor = color => {
      const match = color.match(/^(rgb|hsl)a[(](.*),([^,]*)[)]$/);
      if (!match) return { rgb: color, alpha: 1 };
      return { rgb: match[1] + '(' + match[2] + ')', alpha: parseFloat(match[3]) };
    };

    const materialCache = new Map();
    const getNodeMaterial = node => {
      const { rgb, alpha } = splitColor(getNodeColor(node));
      const opacity = Math.round(alpha * (focus.node ? 1 : BASE_NODE_OPACITY) * 100) / 100;
      const key = rgb + '|' + opacity;
      if (!materialCache.has(key)) {
        materialCache.set(key, new THREE.MeshLambertMaterial({ color: rgb, transparent: true, opacity }));
      }
      return materialCache.get(key);
    };

    const buildNodeMesh = node => new THREE.Mesh(getShapeGeometry(getNodeShape(node)), getNodeMaterial(node));

    // Link ends are ids until the graph has processed the link, then node objects.
    const isNodeObject = end => Boolean(end && typeof end === 'object');

    const getLinkColor = link => {
      const base = link.type === 'ai' ? MINED_LINK_COLOR : DEFAULT_LINK_COLOR;
      if (focus.node) return withAlpha(base, focus.links.has(link) ? 1 : FOCUS_DIM_OPACITY);
      if (filterState.highlighted.size && ![link.source, link.target].some(end => isNodeObject(end) && isHighlighted(end))) return DIM_LINK_COLOR;
      return base;
    };

    const isSameCategoryLink = link => isNodeObject(link.source) && isNodeObject(link.target) &&
      getNodeCategory(link.source) === getNodeCategory(link.target);

    // Each category gets a fixed anchor on a sphere; a weak pull toward it turns categories into separate islands.
    const CLUSTER_RADIUS = 220;
    const CLUSTER_STRENGTH = 0.06;
    const clusterAnchors = new Map();
    const clusterIndexes = new Map();
    const getClusterIndex = category => {
      if (!clusterIndexes.has(category)) {
        const known = CATEGORY_ORDER.indexOf(category);
        clusterIndexes.set(category, known >= 0 ? known : CATEGORY_ORDER.length + clusterIndexes.size);
      }
      return clusterIndexes.get(category);
    };

    // In 2D mode categories sit on a flat grid of wide rows, like a node editor canvas.
    const FLAT_COLUMNS = 4;
    const FLAT_SPACING_X = 200;
    const FLAT_SPACING_Y = 150;
    const flatAnchors = new Map();
    const getFlatAnchor = category => {
      if (!flatAnchors.has(category)) {
        const index = getClusterIndex(category);
        const rows = Math.ceil(Math.max(CATEGORY_ORDER.length, index + 1) / FLAT_COLUMNS);
        const col = index % FLAT_COLUMNS;
        const row = Math.floor(index / FLAT_COLUMNS);
        flatAnchors.set(category, {
          x: (col - (FLAT_COLUMNS - 1) / 2) * FLAT_SPACING_X,
          y: ((rows - 1) / 2 - row) * FLAT_SPACING_Y,
          z: 0
        });
      }
      return flatAnchors.get(category);
    };

    const getClusterAnchor = category => {
      if (filterState.flat) return getFlatAnchor(category);
      if (!clusterAnchors.has(category)) {
        const index = getClusterIndex(category);
        const total = Math.max(CATEGORY_ORDER.length, index + 1);
        // Fibonacci sphere spreads anchors evenly around the origin.
        const y = 1 - (2 * (index + 0.5)) / total;
        const r = Math.sqrt(1 - y * y);
        const theta = index * Math.PI * (3 - Math.sqrt(5));
        clusterAnchors.set(category, { x: Math.cos(theta) * r * CLUSTER_RADIUS, y: y * CLUSTER_RADIUS, z: Math.sin(theta) * r * CLUSTER_RADIUS });
      }
      return clusterAnchors.get(category);
    };

    const clusterForce = () => {
      let nodes = [];
      const force = alpha => {
        const k = CLUSTER_STRENGTH * alpha;
        nodes.forEach(node => {
          const anchor = getClusterAnchor(getNodeCategory(node));
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
      const haystack = ((node.title || '') + ' ' + (node.url || '') + ' ' + getNodeCategory(node)).toLowerCase();
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
        url: node.url || ''
      };
    };

    const normalizeGraphData = data => {
      const nodes = (data && Array.isArray(data.nodes) ? data.nodes : []).map(safeGraphNode);
      const links = (data && Array.isArray(data.links)) ? data.links : [];
      return { nodes, links };
    };

    let graphData = { nodes: [], links: [] };

    const nodeCard = document.getElementById('node-card');
    const legend = document.getElementById('legend');
    const legendItems = document.getElementById('legend-items');
    // Start collapsed on phones so the legend doesn't cover the graph.
    if (window.matchMedia('(max-width: 768px)').matches) legend.open = false;
    const cardTitle = document.getElementById('card-title');
    const cardTag = document.getElementById('card-tag');
    const cardDescription = document.getElementById('card-description');
    const cardMeta = document.getElementById('card-meta');
    const cardLink = document.getElementById('card-link');

    const PREVIEW_LENGTH = 220;
    const truncate = (text, max) => text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;

    const getHostname = url => {
      try { return new URL(url).hostname.replace(/^www[.]/, ''); } catch (err) { return ''; }
    };

    // Links show their fetched description; notes store their full text in url, so preview that instead.
    const getPreviewText = (node, isLink) => {
      if (node.description) return truncate(String(node.description), PREVIEW_LENGTH);
      if (!isLink && node.url && node.url !== node.title) return truncate(String(node.url), PREVIEW_LENGTH);
      return '';
    };

    const showNodeCard = node => {
      const isLink = Boolean(node.url && /^https?:/i.test(node.url));
      cardTitle.textContent = node.title || node.name || 'Saved Entry';
      cardTag.textContent = getNodeCategory(node).replace(/_/g, ' ').toUpperCase();

      const preview = getPreviewText(node, isLink);
      cardDescription.textContent = preview;
      cardDescription.style.display = preview ? 'block' : 'none';

      const created = node.created_at ? new Date(node.created_at) : null;
      const meta = [];
      if (isLink) meta.push(getHostname(node.url));
      if (created && !Number.isNaN(created.getTime())) meta.push(created.toLocaleString());
      cardMeta.textContent = meta.filter(Boolean).join(' · ');

      if (isLink) {
        cardLink.href = node.url;
        cardLink.style.display = 'inline-block';
      } else {
        cardLink.removeAttribute('href');
        cardLink.style.display = 'none';
      }
      nodeCard.style.display = 'block';
      // The card spans the bottom of the screen, so the legend steps aside while it's open.
      legend.style.display = 'none';
    };

    // Fresh accessors make the graph re-evaluate colors, widths and particles.
    const refreshGraphStyles = () => {
      Graph
        .nodeColor(node => getNodeColor(node))
        .linkColor(link => getLinkColor(link))
        .linkWidth(link => focus.links.has(link) ? 1.5 : (link.type === 'ai' ? 1.2 : 0))
        .linkDirectionalParticles(link => focus.links.has(link) ? 4 : 0);
      // Custom meshes ignore nodeColor/nodeOpacity, so they are rebuilt with the current colors.
      if (THREE) Graph.nodeThreeObject(node => buildNodeMesh(node));
      if (territories.group) territories.group.visible = !focus.node;
    };

    // Each visible category gets a faint wireframe shell and a floating label around its cluster.
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
      territories.group.remove(entry.shell, entry.label);
      entry.shell.material.dispose();
      entry.label.material.map.dispose();
      entry.label.material.dispose();
    };

    const syncTerritories = visibleNodes => {
      territories.visibleNodes = visibleNodes;
      if (!territories.group) return;
      const categories = new Set(visibleNodes.map(getNodeCategory));
      territories.entries.forEach((entry, category) => {
        if (categories.has(category)) return;
        disposeTerritory(entry);
        territories.entries.delete(category);
      });
      categories.forEach(category => {
        if (territories.entries.has(category)) return;
        const color = getCategoryColor(category);
        const shell = new THREE.Mesh(territories.shellGeometry, new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.07, depthWrite: false }));
        const label = makeLabelSprite(category.replace(/_/g, ' ').toUpperCase(), color);
        label.userData.category = category;
        territories.group.add(shell, label);
        territories.entries.set(category, { shell, label });
      });
      updateTerritories();
    };

    const updateTerritories = () => {
      if (!territories.group) return;
      const groups = new Map();
      territories.visibleNodes.forEach(node => {
        if (!Number.isFinite(node.x)) return;
        const category = getNodeCategory(node);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(node);
      });
      territories.entries.forEach((entry, category) => {
        const nodes = groups.get(category) || [];
        entry.shell.visible = entry.label.visible = nodes.length > 0;
        if (!nodes.length) return;
        const center = { x: 0, y: 0, z: 0 };
        nodes.forEach(node => { center.x += node.x; center.y += node.y; center.z += node.z || 0; });
        center.x /= nodes.length;
        center.y /= nodes.length;
        center.z /= nodes.length;
        const spread = Math.max(...nodes.map(node => Math.hypot(node.x - center.x, node.y - center.y, (node.z || 0) - center.z)));
        const radius = Math.max(spread + 12, 18);
        entry.shell.position.set(center.x, center.y, center.z);
        entry.shell.scale.setScalar(radius);
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
      return hit ? hit.object.userData.category : null;
    };

    const flyToCategory = category => {
      const entry = territories.entries.get(category);
      if (!entry || !entry.center) return;
      const center = entry.center;
      const distance = entry.radius * 2.5 + 60;
      let position;
      if (filterState.flat) {
        position = { x: center.x, y: center.y, z: distance };
      } else {
        const cam = Graph.camera().position;
        const dir = { x: cam.x - center.x, y: cam.y - center.y, z: cam.z - center.z };
        const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
        position = { x: center.x + dir.x / length * distance, y: center.y + dir.y / length * distance, z: center.z + dir.z / length * distance };
      }
      pauseAutoRotate();
      Graph.cameraPosition(position, { x: center.x, y: center.y, z: center.z }, 1200);

      const onlyThis = filterState.highlighted.size === 1 && filterState.highlighted.has(category);
      filterState.highlighted = onlyThis ? new Set() : new Set([category]);
      applyGraphFilters();
    };

    const handleBackgroundClick = () => {
      const category = pickLabel();
      if (category) flyToCategory(category);
      else hideNodeCard();
    };

    // Slow idle orbit that yields to any interaction and resumes after a quiet spell.
    const IDLE_RESUME_MS = 5000;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let idleTimer = null;
    const resumeAutoRotate = () => {
      const controls = Graph.controls();
      controls.autoRotate = !focus.node && !filterState.flat && !reducedMotion.matches;
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
      focus.links = new Set();
      Graph.graphData().links.forEach(link => {
        const sourceId = linkEndId(link.source);
        const targetId = linkEndId(link.target);
        if (sourceId !== node.id && targetId !== node.id) return;
        focus.links.add(link);
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
      focus.links = new Set();
      Graph.nodeOpacity(BASE_NODE_OPACITY).linkOpacity(BASE_LINK_OPACITY);
      refreshGraphStyles();
    };

    const selectNode = node => {
      showNodeCard(node);
      setFocus(node);
      pauseAutoRotate();
    };

    const hideNodeCard = () => {
      nodeCard.style.display = 'none';
      legend.style.display = 'block';
      clearFocus();
      scheduleResume();
    };

    const Graph = ForceGraph3D({ controlType: 'orbit' })(document.getElementById('3d-graph'))
      .nodeLabel(node => {
        const title = node.title || node.name || 'Saved Entry';
        return escapeHtml(title + ' [' + getNodeCategory(node).toUpperCase() + ']');
      })
      .nodeOpacity(BASE_NODE_OPACITY)
      .linkOpacity(BASE_LINK_OPACITY)
      .linkWidth(link => link.type === 'ai' ? 1.2 : 0)
      .linkDirectionalParticleSpeed(0.008)
      .linkDirectionalParticleWidth(2.5)
      .linkDirectionalParticleColor(() => '#00ffcc')
      .onNodeClick(selectNode)
      .onBackgroundClick(handleBackgroundClick)
      .onEngineTick(onTerritoryTick)
      .onEngineStop(updateTerritories)
      .onNodeDragEnd(updateTerritories);

    document.getElementById('card-close').addEventListener('click', hideNodeCard);

    const graphControls = Graph.controls();
    graphControls.autoRotateSpeed = 0.5;
    graphControls.addEventListener('start', pauseAutoRotate);
    graphControls.addEventListener('end', scheduleResume);
    document.getElementById('3d-graph').addEventListener('pointerdown', event => {
      lastPointer = { x: event.clientX, y: event.clientY };
      pauseAutoRotate();
    });
    resumeAutoRotate();

    import('https://unpkg.com/three@0.180.0/build/three.module.js')
      .then(module => {
        THREE = module;
        territories.group = new THREE.Group();
        territories.shellGeometry = new THREE.SphereGeometry(1, 20, 14);
        Graph.scene().add(territories.group);
        refreshGraphStyles();
        syncTerritories(territories.visibleNodes);
      })
      .catch(err => console.error('three.js failed to load; keeping default node spheres', err));

    // Short, stiff links inside a category and long, loose ones across categories keep islands apart.
    Graph.d3Force('charge').strength(-40).distanceMax(260);
    Graph.d3Force('link')
      .distance(link => isSameCategoryLink(link) ? 22 : 110)
      .strength(link => isSameCategoryLink(link) ? 0.5 : 0.03);
    Graph.d3Force('cluster', clusterForce());

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
        item.addEventListener('click', () => toggleHighlight(category));
        return item;
      }));
      legend.style.visibility = categories.length ? 'visible' : 'hidden';
    };

    const applyGraphFilters = () => {
      const filteredNodes = graphData.nodes.filter(node => matchesTypeFilter(node) && matchesTimeFilter(node) && matchesSearch(node));
      const visibleIds = new Set(filteredNodes.map(node => node.id));
      const filteredLinks = graphData.links.filter(link => visibleIds.has(linkEndId(link.source)) && visibleIds.has(linkEndId(link.target)));

      Graph.graphData({ nodes: filteredNodes, links: filteredLinks });
      // A focused node that got filtered out drops the focus along with its card.
      if (focus.node && !visibleIds.has(focus.node.id)) hideNodeCard();
      else if (focus.node) setFocus(focus.node);
      else refreshGraphStyles();
      renderLegend(filteredNodes);
      syncTerritories(filteredNodes);
    };

    const loadGraph = async () => {
      const res = await fetch('/api/graph');
      if (!res.ok) throw new Error('Graph request failed: ' + res.status);
      graphData = normalizeGraphData(await res.json());
      pinToPlane(graphData.nodes);
      applyGraphFilters();
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
        }
      });
    };

    const viewToggle = document.getElementById('view-toggle');
    viewToggle.addEventListener('click', () => {
      filterState.flat = !filterState.flat;
      viewToggle.textContent = filterState.flat ? '3D Graph' : '2D Canvas';
      viewToggle.classList.toggle('active', filterState.flat);
      pinToPlane(graphData.nodes);

      const controls = Graph.controls();
      // Trackball controls (the default) use noRotate; orbit controls use enableRotate.
      controls.noRotate = filterState.flat;
      controls.enableRotate = !filterState.flat;
      // In 2D, left-drag pans instead of rotating (THREE.MOUSE: 0 = rotate, 2 = pan).
      if (controls.mouseButtons) controls.mouseButtons.LEFT = filterState.flat ? 2 : 0;

      if (filterState.flat) {
        // Undo any roll left over from 3D rotation so the canvas sits square on screen.
        Graph.camera().up.set(0, 1, 0);
        Graph.cameraPosition({ x: 0, y: 0, z: 600 }, { x: 0, y: 0, z: 0 }, 800);
      }
      pauseAutoRotate();
      Graph.d3ReheatSimulation();
    });

    document.querySelectorAll('.filter-pill').forEach(button => {
      button.addEventListener('click', () => {
        filterState.type = button.dataset.filter || 'all';
        document.querySelectorAll('.filter-pill').forEach(btn => btn.classList.toggle('active', btn === button));
        applyGraphFilters();
      });
    });

    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', () => {
      filterState.query = searchInput.value.trim().toLowerCase();
      applyGraphFilters();
    });

    const timeFilter = document.getElementById('time-filter');
    timeFilter.addEventListener('change', () => {
      filterState.horizon = timeFilter.value || 'all';
      applyGraphFilters();
    });

    const clusterToggle = document.getElementById('cluster-toggle');
    clusterToggle.addEventListener('click', () => {
      filterState.clusterMode = filterState.clusterMode === 'category' ? 'rainbow' : 'category';
      clusterToggle.textContent = filterState.clusterMode === 'category' ? 'Category View' : 'Rainbow View';
      clusterToggle.classList.toggle('active', filterState.clusterMode === 'category');
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
    clearFiltersButton.addEventListener('click', () => {
      filterState.type = 'all';
      filterState.horizon = 'all';
      filterState.query = '';
      filterState.clusterMode = 'category';
      filterState.highlighted.clear();
      timeFilter.value = 'all';
      searchInput.value = '';
      clusterToggle.textContent = 'Category View';
      clusterToggle.classList.add('active');
      document.querySelectorAll('.filter-pill').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
      settingsMenu.classList.remove('open');
      filterMenu.open = false;
      applyGraphFilters();
    });

    const getAdminToken = () => {
      let token = localStorage.getItem(ADMIN_TOKEN_KEY);
      if (!token) {
        token = (window.prompt('Admin token required to recluster:') || '').trim();
        if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
      }
      return token;
    };

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

    loadGraph().catch(err => console.error('Graph Load Error:', err));
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};

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

// D1 stores CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" (UTC); browsers parse that inconsistently.
function toIsoTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(" ", "T") + "Z" : text;
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

function isGenericPlaceholder(text) {
  const lower = String(text || "").toLowerCase();
  return /(look into this|look into that|look into it|check this out|look at this|something like this|placeholder|tbd)/.test(lower) || lower === "this" || lower === "that";
}

// Finds the link saved in the 60 seconds before `referenceTime` (a D1 timestamp, or null for now).
async function findRecentLinkContext(env, referenceTime, excludeId = null) {
  try {
    const ref = referenceTime ? String(referenceTime) : "now";
    return await env.DB.prepare(
      "SELECT id, title, description, url, category FROM saved_nodes WHERE category IN ('link', 'article', 'video') AND id != ? AND created_at <= datetime(?) AND created_at >= datetime(?, '-60 seconds') ORDER BY created_at DESC LIMIT 1"
    ).bind(excludeId || "", ref, ref).first();
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
    const context = await findRecentLinkContext(env, node.created_at, node.id);
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

// Cron job: one batched Gemini prompt assigns categories to unanalyzed nodes and extracts edges
// between them and recently analyzed nodes. Nodes stay unprocessed (and retry tomorrow) if Gemini fails.
async function mineConnections(env) {
  if (!env.GEMINI_API_KEY) {
    console.error("Connection miner skipped: GEMINI_API_KEY is not configured.");
    return;
  }

  const { results: newRows } = await env.DB.prepare(
    "SELECT id, title, url, category FROM saved_nodes WHERE ai_processed_at IS NULL ORDER BY rowid LIMIT ?"
  ).bind(MINER_BATCH_SIZE).all();
  const newNodes = newRows || [];
  if (!newNodes.length) return;

  const { results: contextRows } = await env.DB.prepare(
    "SELECT id, title, url, category FROM saved_nodes WHERE ai_processed_at IS NOT NULL ORDER BY ai_processed_at DESC LIMIT ?"
  ).bind(MINER_CONTEXT_SIZE).all();
  const allNodes = [...newNodes, ...(contextRows || [])];

  let mined;
  try {
    const prompt = buildMinerPrompt(newNodes, contextRows || [], RECLUSTER_CATEGORIES);
    const parsed = await callGeminiJson(env.GEMINI_API_KEY, prompt, 16384);
    mined = parseMinerResponse(parsed, newNodes.length, allNodes.length, normalizeCategory);
  } catch (err) {
    console.error("Connection miner Gemini call failed:", err);
    return;
  }

  const statements = [];
  mined.categories.forEach((category, i) => {
    const node = newNodes[i];
    const current = String(node.category || "").toLowerCase();
    // Videos are detected from the URL; like /api/recluster, only re-tag the AI-managed categories.
    if (!RECLUSTER_CATEGORIES.includes(current) || category === current) return;
    statements.push(env.DB.prepare(
      "UPDATE saved_nodes SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(category, node.id));
  });
  for (const { a, b, relation } of mined.edges) {
    const [sourceId, targetId] = [String(allNodes[a].id), String(allNodes[b].id)].sort();
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO node_edges (source_id, target_id, relation) VALUES (?, ?, ?)"
    ).bind(sourceId, targetId, relation));
  }
  statements.push(env.DB.prepare(
    `UPDATE saved_nodes SET ai_processed_at = CURRENT_TIMESTAMP WHERE id IN (${newNodes.map(() => "?").join(", ")})`
  ).bind(...newNodes.map(node => node.id)));

  await env.DB.batch(statements);
  console.log(`Connection miner: analyzed ${newNodes.length} nodes, ${statements.length - 1 - mined.edges.length} re-tagged, ${mined.edges.length} edges.`);
}

// Missing table (migration not applied yet) just means no mined edges.
async function loadMinedEdges(env) {
  try {
    const { results } = await env.DB.prepare("SELECT source_id, target_id, relation FROM node_edges").all();
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

async function sendTelegram(token, chatId, text) {
  return await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}
