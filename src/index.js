const VIDEO_URL_PATTERN = /(youtube\.com|youtu\.be|facebook\.com\/(reel|watch)|fb\.watch|instagram\.com\/(reel|tv)|tiktok\.com|vimeo\.com|x\.com\/i\/status|twitter\.com\/i\/status|\.mp4(\?|$)|\.webm(\?|$)|\.mov(\?|$)|\.m4v(\?|$))/i;

const VALID_CATEGORIES = ["note", "link", "article", "dev_task", "monetization", "ai_tool", "marketing", "route_plan", "general", "video"];
const RECLUSTER_CATEGORIES = ["note", "general", "link", "article", "dev_task", "monetization", "ai_tool", "marketing", "route_plan"];

// Keeps each recluster request well under the Workers subrequest / D1 query limits:
// per node at most 1 context lookup + 1 Gemini call + 1 update.
const RECLUSTER_BATCH_SIZE = 10;
const MAX_SEMANTIC_LINKS_PER_NODE = 5;

const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with", "is", "https", "http", "com", "www"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint 1: API returning JSON graph data
    if (url.pathname === "/api/graph" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, title, category, url, created_at FROM saved_nodes"
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
            url: rawUrl,
            type: category,
            created_at: toIsoTimestamp(node.created_at)
          };
        });

        return jsonResponse({ nodes, links: buildGraphLinks(nodes) });
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

    // Endpoint 3: Telegram Webhook POST
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

        let category = "note";
        if (text.startsWith("http://") || text.startsWith("https://")) {
          category = inferNodeCategory(text, "link");
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
            text = String(contextualLink.url || text);
          }
        }

        await env.DB.prepare(
          "INSERT INTO saved_nodes (id, url, title, category) VALUES (?, ?, ?, ?)"
        ).bind(id, text, extractedTitle, category).run();

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

    // Endpoint 4: Mobile-Optimized 3D Visualizer UI
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
    #info {
      position: absolute;
      top: 15px;
      left: 15px;
      color: #00ffcc;
      z-index: 10;
      background: rgba(8, 12, 20, 0.85);
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid rgba(0, 255, 204, 0.2);
      backdrop-filter: blur(8px);
    }
    #search-input {
      appearance: none;
      border: 1px solid rgba(0,255,204,0.25);
      background: rgba(255,255,255,0.04);
      color: #00ffcc;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      outline: none;
      width: 150px;
    }
    #search-input::placeholder { color: rgba(0,255,204,0.4); }
    .filter-panel {
      position: absolute;
      left: 50%;
      top: 76px;
      transform: translateX(-50%);
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      border-radius: 16px;
      background: rgba(12, 18, 30, 0.6);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 12px 32px rgba(0,0,0,0.28);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      flex-wrap: wrap;
      justify-content: center;
      max-width: min(92vw, 860px);
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
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
    .settings-wrap {
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 30;
    }
    .settings-button {
      position: relative;
      z-index: 31;
      border: 1px solid rgba(0,255,204,0.35);
      background: rgba(8, 12, 20, 0.85);
      color: #dffdf7;
      border-radius: 12px;
      padding: 10px 14px;
      cursor: pointer;
      font-size: 14px;
    }
    .settings-menu {
      position: absolute;
      right: 0;
      top: 52px;
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
    #node-card h3 { margin: 0 0 6px 0; font-size: 15px; color: #00ffcc; }
    #node-card p { margin: 0 0 12px 0; font-size: 13px; color: #ccc; word-break: break-word; line-height: 1.4; }
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
  </style>
  <script src="https://unpkg.com/3d-force-graph@1.80.0/dist/3d-force-graph.min.js"></script>
</head>
<body>
  <div id="info">
    <h2 style="margin:0 0 2px 0; font-size:15px;">Aether Portal</h2>
    <p style="margin:0; font-size:11px; color:#aaa;">Tap node to inspect</p>
  </div>

  <div class="filter-panel">
    <div class="filter-row" id="type-filters">
      <button class="filter-pill active" data-filter="all">All</button>
      <button class="filter-pill" data-filter="link">Links</button>
      <button class="filter-pill" data-filter="dev_task">Dev Tasks</button>
      <button class="filter-pill" data-filter="video">Videos</button>
      <button class="filter-pill" data-filter="note">Notes</button>
    </div>
    <div class="filter-row">
      <input type="text" id="search-input" placeholder="🔍 Search nodes...">
      <select id="time-filter">
        <option value="all">All Time</option>
        <option value="day">Today</option>
        <option value="week">Last 7 Days</option>
        <option value="month">Last 30 Days</option>
      </select>
      <button id="cluster-toggle" class="toggle-button active" data-mode="category">Category View</button>
    </div>
  </div>

  <div class="settings-wrap">
    <button class="settings-button" id="settings-toggle">⚙️ Settings</button>
    <div class="settings-menu" id="settings-menu">
      <button class="settings-option" id="recluster-button">⚡ Recluster Graph with AI</button>
      <button class="settings-option" id="clear-filters-button">Clear Filters</button>
    </div>
  </div>

  <div id="node-card">
    <h3 id="card-title">Node Details</h3>
    <p id="card-body">Content text goes here...</p>
    <a id="card-link" href="#" target="_blank" rel="noopener noreferrer">Open Link ↗</a>
  </div>

  <div id="3d-graph" style="width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;"></div>

  <script>
    const ADMIN_TOKEN_KEY = 'aetherAdminToken';

    const filterState = {
      type: 'all',
      horizon: 'all',
      query: '',
      clusterMode: 'category'
    };

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
    const cardTitle = document.getElementById('card-title');
    const cardBody = document.getElementById('card-body');
    const cardLink = document.getElementById('card-link');

    const showNodeCard = node => {
      cardTitle.textContent = node.title || node.name || 'Saved Entry';
      const created = node.created_at ? new Date(node.created_at) : null;
      const details = [getNodeCategory(node).toUpperCase()];
      if (created && !Number.isNaN(created.getTime())) details.push(created.toLocaleString());
      if (node.url) details.push(node.url);
      cardBody.textContent = details.join(' · ');
      if (node.url && /^https?:/i.test(node.url)) {
        cardLink.href = node.url;
        cardLink.style.display = 'inline-block';
      } else {
        cardLink.removeAttribute('href');
        cardLink.style.display = 'none';
      }
      nodeCard.style.display = 'block';
    };

    const hideNodeCard = () => { nodeCard.style.display = 'none'; };

    const Graph = ForceGraph3D()(document.getElementById('3d-graph'))
      .nodeLabel(node => {
        const title = node.title || node.name || 'Saved Entry';
        return escapeHtml(title + ' [' + getNodeCategory(node).toUpperCase() + ']');
      })
      .onNodeClick(showNodeCard)
      .onBackgroundClick(hideNodeCard);

    const applyGraphFilters = () => {
      const filteredNodes = graphData.nodes.filter(node => matchesTypeFilter(node) && matchesTimeFilter(node) && matchesSearch(node));
      const visibleIds = new Set(filteredNodes.map(node => node.id));
      const filteredLinks = graphData.links.filter(link => visibleIds.has(linkEndId(link.source)) && visibleIds.has(linkEndId(link.target)));

      Graph.graphData({ nodes: filteredNodes, links: filteredLinks });

      if (filterState.clusterMode === 'rainbow') {
        Graph.nodeColor(node => getRainbowColor(node));
      } else {
        Graph.nodeColor('color').nodeAutoColorBy('category');
      }
    };

    const loadGraph = async () => {
      const res = await fetch('/api/graph');
      if (!res.ok) throw new Error('Graph request failed: ' + res.status);
      graphData = normalizeGraphData(await res.json());
      applyGraphFilters();
    };

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

    const clearFiltersButton = document.getElementById('clear-filters-button');
    clearFiltersButton.addEventListener('click', () => {
      filterState.type = 'all';
      filterState.horizon = 'all';
      filterState.query = '';
      filterState.clusterMode = 'category';
      timeFilter.value = 'all';
      searchInput.value = '';
      clusterToggle.textContent = 'Category View';
      clusterToggle.classList.add('active');
      document.querySelectorAll('.filter-pill').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
      settingsMenu.classList.remove('open');
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

    const reclusterButton = document.getElementById('recluster-button');
    reclusterButton.addEventListener('click', async () => {
      const token = getAdminToken();
      if (!token) return;

      reclusterButton.disabled = true;
      let processed = 0;
      let updated = 0;
      let cursor = 0;
      try {
        while (true) {
          reclusterButton.textContent = '🧠 Gemini is organizing nodes... (' + processed + ')';
          const res = await fetch('/api/recluster?cursor=' + encodeURIComponent(cursor), {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token }
          });
          if (res.status === 401) {
            localStorage.removeItem(ADMIN_TOKEN_KEY);
            throw new Error('Admin token rejected.');
          }
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || ('Recluster failed: ' + res.status));
          processed += body.processed || 0;
          updated += body.updated || 0;
          if (body.done || body.nextCursor === cursor) break;
          cursor = body.nextCursor;
        }
        await loadGraph();
        alert('Reclustered ' + updated + ' of ' + processed + ' nodes with Gemini AI.');
      } catch (err) {
        console.error('Recluster failed:', err);
        alert(err.message || 'Recluster failed.');
      } finally {
        reclusterButton.disabled = false;
        reclusterButton.textContent = '⚡ Recluster Graph with AI';
        settingsMenu.classList.remove('open');
      }
    });

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
      "SELECT id, title, url, category FROM saved_nodes WHERE category IN ('link', 'article', 'video') AND id != ? AND created_at <= datetime(?) AND created_at >= datetime(?, '-60 seconds') ORDER BY created_at DESC LIMIT 1"
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
  const sourceText = (currentUrl || currentTitle).trim();

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
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
          // 2.5 Flash thinks by default and thinking tokens count against maxOutputTokens.
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const rawModelText = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
    const cleanedText = rawModelText.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(cleanedText);

    const title = String(parsed?.title || "").trim().slice(0, 200);
    if (!title) throw new Error("Gemini returned no title");
    const category = normalizeCategory(parsed.category, sourceText.startsWith("http") ? "link" : fallbackCategory);

    return { title, category };
  } catch (err) {
    console.error("Gemini analysis failed:", err);
    return null;
  }
}

async function sendTelegram(token, chatId, text) {
  return await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}
