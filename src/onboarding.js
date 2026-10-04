// First-run onboarding: the tutorial graph a new user sees on their first sign-in (a hub, an import guide that can carry
// a YouTube walkthrough, and a thumb wheel guide, wired with "tutorial" links). Seeded once per user, by /api/graph,
// when the user has no nodes; users.onboarded_at (migration 0017) keeps it from running again.

export const ONBOARDING_RELATION = "tutorial";
const YOUTUBE_URL = /^https:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}([?&#].*)?$/;

// The walkthrough video for the import guide (the ONBOARDING_VIDEO_URL var), or null when unset or not a YouTube link.
export function onboardingVideoUrl(env) {
  const raw = String(env?.ONBOARDING_VIDEO_URL || "").trim();
  return YOUTUBE_URL.test(raw) ? raw : null;
}

// The seed rows: { nodes: [{ key, id, url, title, description, category }], edges: [{ source_id, target_id }] }.
// Edges are stored undirected, smaller id first, like every node_edges row.
export function buildOnboardingSeed({ videoUrl = null, makeId = () => "node_" + crypto.randomUUID() } = {}) {
  const nodes = [
    {
      key: "welcome",
      url: "",
      category: "note",
      title: "Welcome to Aether Portal",
      description: [
        "This is your knowledge graph. Every link, note, video and idea you save becomes a card, and related cards are wired together.",
        "",
        "• Tap a card to open it, and Expand Full Reader to read it in full.",
        "• Ask Elarion about any card in the box at the bottom of the card.",
        "• Use 🔗 Link to… on a card to connect it to another one.",
        "• The daily connection miner finds relationships between your saves overnight.",
        "",
        "Start with the two cards linked to this one, then delete these tutorial cards whenever you like."
      ].join("\n")
    },
    {
      key: "import",
      url: videoUrl || "",
      category: videoUrl ? "video" : "note",
      title: "How to Import Links & Media",
      description: [
        videoUrl ? "Watch the walkthrough above, or read the short version:" : "The short version:",
        "",
        "• + Add (the button in the top bar, or the hub of the wheel): type a note, or paste a link to save it with its preview.",
        "• Telegram: send the bot a link to save it. /link <url> [note], /research <topic or link>, /ask <question> and /help also work.",
        "• Share sheet: install the portal as an app on your phone, then share a page or video to Aether Portal.",
        "",
        "YouTube links play right on their card, and Get Transcript writes a synopsis from the captions.",
        "",
        "Getting around: drag to orbit, pinch or scroll to zoom, and tap empty space to deselect."
      ].join("\n")
    },
    {
      key: "wheel",
      url: "",
      category: "note",
      title: "Spatial ThumbWheel Guide",
      description: [
        "The wheel in the bottom-right corner drives the whole view. Turn a ring like a dial, or tap a label to jump to it.",
        "",
        "• Outer rim (View): 3D Space, List, Timeline, Board and Carousel.",
        "• Scale (in 3D Space): Space (everything), Cluster (one group), Horizon (a group's wall) and Atomic (one card).",
        "• Inner rings follow the scale: Time in Space, Depth in Cluster, Show in Horizon, and Card in Atomic, which steps through the cards in the cluster.",
        "• The hub (+) adds a node. Home recentres the view.",
        "• Simple mode shows only the two outer rings. Switch to Advanced for the rest.",
        "",
        "On desktop the mouse wheel turns whichever ring is under the pointer."
      ].join("\n")
    }
  ].map(node => ({ ...node, id: makeId() }));

  const byKey = Object.fromEntries(nodes.map(node => [node.key, node.id]));
  const edges = [["welcome", "import"], ["welcome", "wheel"], ["import", "wheel"]].map(([a, b]) => {
    const [source_id, target_id] = byKey[a] < byKey[b] ? [byKey[a], byKey[b]] : [byKey[b], byKey[a]];
    return { source_id, target_id };
  });
  return { nodes, edges };
}

// Seeds the tutorial graph for a user with no nodes. Claims users.onboarded_at first, so it runs at most once per user
// even when two graph loads race; returns whether it seeded. A user with no users row is never seeded.
export async function seedOnboardingGraph(env, userId, options = {}) {
  const claim = await env.DB.prepare("UPDATE users SET onboarded_at = CURRENT_TIMESTAMP WHERE id = ? AND onboarded_at IS NULL").bind(userId).run();
  if (!claim?.meta?.changes) return false;

  const { nodes, edges } = buildOnboardingSeed({ videoUrl: onboardingVideoUrl(env), ...options });
  // Marked as AI-processed so the daily cron keeps these categories. A failed seed gives the claim back, so the next
  // graph load tries again.
  const statements = [
    ...nodes.map(node => env.DB.prepare(
      "INSERT INTO saved_nodes (id, user_id, url, title, description, category, ai_processed_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
    ).bind(node.id, userId, node.url, node.title, node.description, node.category)),
    ...edges.map(edge => env.DB.prepare(
      "INSERT OR IGNORE INTO node_edges (source_id, target_id, relation, user_id) VALUES (?, ?, ?, ?)"
    ).bind(edge.source_id, edge.target_id, ONBOARDING_RELATION, userId))
  ];
  try {
    await env.DB.batch(statements);
  } catch (err) {
    await env.DB.prepare("UPDATE users SET onboarded_at = NULL WHERE id = ?").bind(userId).run();
    throw err;
  }
  return true;
}
