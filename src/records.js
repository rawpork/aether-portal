// Context retrieval over the records table (migrations/0019_records.sql): the engine's two tools, search_records and get_record,
// plus the write that blueprints use to enter the index (cards, outcomes and websites are indexed by D1 triggers as they are saved).
// Every query is scoped to one user. Bodies are not stored here: body_ref points at where they live.

export const RECORDS_LIMIT_DEFAULT = 10;
export const RECORDS_LIMIT_MAX = 50;
export const RECORD_TYPES = ["card", "blueprint", "phase_output", "deliverable", "note", "run", "conversation"];
const TEXT_MAX = 2000;
const ID_MAX = 200;
const COLUMNS = "r.id, r.project_id, r.run_id, r.type, r.title, r.summary, r.body_ref, r.tags, r.created_at, r.updated_at";

export function clampLimit(value) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 1) return RECORDS_LIMIT_DEFAULT;
	return Math.min(n, RECORDS_LIMIT_MAX);
}

const words = text => (String(text == null ? "" : text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12);

// Free text to a safe FTS5 query: each word quoted (so operators and punctuation are plain text), the last one a prefix, all
// required (AND). Returns null when there is nothing to search for.
export function toMatchQuery(text) {
	const list = words(text);
	if (!list.length) return null;
	return list.map((w, i, all) => '"' + w + '"' + (i === all.length - 1 ? "*" : "")).join(" ");
}

// The looser form for a multi-word query that found nothing: any word may match, each as a prefix. Null for fewer than two words.
export function toOrQuery(text) {
	const list = words(text);
	return list.length > 1 ? list.map(w => '"' + w + '"*').join(" OR ") : null;
}

// search_records(query, project_id?, type?, limit): best matches first (bm25), or the most recent records when the query is empty.
// A multi-word query must match every word first; when that finds nothing it is tried again matching any word (mode "or").
export async function searchRecords(env, userId, { query, project_id, type, limit } = {}) {
	const filters = [];
	const args = [];
	if (project_id) { filters.push("r.project_id = ?"); args.push(String(project_id)); }
	if (type) { filters.push("r.type = ?"); args.push(String(type)); }
	const extra = filters.length ? " AND " + filters.join(" AND ") : "";
	const max = clampLimit(limit);
	const match = toMatchQuery(query);
	if (!match) {
		const { results } = await env.DB.prepare("SELECT " + COLUMNS + " FROM records r WHERE r.user_id = ?" + extra + " ORDER BY r.updated_at DESC LIMIT ?").bind(userId, ...args, max).all();
		return { records: results || [], count: (results || []).length, mode: "recent" };
	}
	const run = async expression => {
		const { results } = await env.DB.prepare("SELECT " + COLUMNS + " FROM records_fts JOIN records r ON r.rowid = records_fts.rowid WHERE records_fts MATCH ? AND r.user_id = ?" + extra + " ORDER BY bm25(records_fts) LIMIT ?").bind(expression, userId, ...args, max).all();
		return results || [];
	};
	let records = await run(match);
	let mode = "and";
	const loose = toOrQuery(query);
	if (!records.length && loose) {
		records = await run(loose);
		mode = "or";
	}
	return { records, count: records.length, mode };
}

// get_record(id): the record, plus the body it points at when that is a saved card (its description, note and link).
export async function getRecord(env, userId, id) {
	const record = await env.DB.prepare("SELECT " + COLUMNS + " FROM records r WHERE r.id = ? AND r.user_id = ?").bind(String(id), userId).first();
	if (!record) return null;
	const thread = /^conversation:(.+)$/.exec(record.body_ref || "");
	if (thread) {
		const { results } = await env.DB.prepare("SELECT role, content FROM conversation_messages WHERE user_id = ? AND thread_id = ? ORDER BY id DESC LIMIT 30").bind(userId, thread[1]).all();
		return { ...record, body: (results || []).reverse().map(m => (m.role === "user" ? "You: " : "Elarion: ") + m.content).join("\n\n") };
	}
	const node = /^saved_nodes:(.+)$/.exec(record.body_ref || "");
	if (!node) return { ...record, body: null };
	const row = await env.DB.prepare("SELECT url, description, user_note, research FROM saved_nodes WHERE id = ? AND user_id = ?").bind(node[1], userId).first();
	const body = row ? [row.description, row.user_note, row.research, row.url].filter(Boolean).join("\n\n") : null;
	return { ...record, body };
}

const text = (value, max = TEXT_MAX) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Adds or updates one record (a blueprint, a run, a note). Cards, outcomes and websites do not come through here.
export async function upsertRecord(env, userId, input) {
	const id = text(input && input.id, ID_MAX);
	const title = text(input && input.title, 300);
	const type = text(input && input.type, 40);
	if (!id) return { error: "id is required." };
	if (!title) return { error: "title is required." };
	if (!RECORD_TYPES.includes(type) || type === "card") return { error: "type must be one of: blueprint, deliverable, note, run." };
	const existing = await env.DB.prepare("SELECT user_id FROM records WHERE id = ?").bind(id).first();
	if (existing && existing.user_id !== userId) return { error: "That id belongs to someone else.", status: 403 };
	const tags = Array.isArray(input.tags) ? input.tags.map(t => text(String(t), 40).toLowerCase()).filter(Boolean).slice(0, 20).join(" ") : text(input.tags, 400);
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO records (id, user_id, project_id, run_id, type, title, summary, body_ref, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
		"ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, run_id = excluded.run_id, type = excluded.type, title = excluded.title, summary = excluded.summary, body_ref = excluded.body_ref, tags = excluded.tags, updated_at = excluded.updated_at",
	).bind(id, userId, text(input.project_id, ID_MAX) || null, text(input.run_id, ID_MAX) || null, type, title, text(input.summary), text(input.body_ref, 500) || null, tags, now, now).run();
	return { id, type };
}

// ---- Account sweep ------------------------------------------------------------------------------------------------------------
// Rebuilds this user's side of the index from what the portal itself holds: every card (raw links, text, outcomes), group and website,
// and every conversation thread; removes records whose card, group or site is gone; then rebuilds the full-text index so nothing is
// left out of it. Engine output (blueprints, phase outputs, runs, documents) is filed by the engine (its own sweep).
const NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

export async function reindexAccount(env, userId, refileThreads) {
	// First make the index agree with the table: the updates below fire triggers that remove old entries from it, which fails on an index that has drifted.
	await env.DB.prepare("INSERT INTO records_fts (records_fts) VALUES ('rebuild')").run();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at) " +
			"SELECT n.id, n.user_id, CASE WHEN n.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(n.title, ''), " +
			"substr(trim(COALESCE(NULLIF(n.description, ''), NULLIF(n.synopsis, ''), '') || ' ' || COALESCE(n.user_note, '')), 1, 600), 'saved_nodes:' || n.id, " +
			"trim(COALESCE(n.category, '') || ' ' || COALESCE(n.site_name, '') || ' ' || COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = n.id), '')), " +
			"COALESCE(CAST(strftime('%s', n.created_at) AS INTEGER) * 1000, 0), " + NOW + " FROM saved_nodes n WHERE n.user_id = ? " +
			"ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, summary = excluded.summary, tags = excluded.tags",
		).bind(userId),
		env.DB.prepare(
			"INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at) " +
			"SELECT 'group:' || g.id, g.user_id, 'note', g.name, 'A group of cards named ' || g.name || '.', 'node_groups:' || g.id, 'group ' || COALESCE(g.source, ''), " +
			"COALESCE(CAST(strftime('%s', g.created_at) AS INTEGER) * 1000, 0), " + NOW + " FROM node_groups g WHERE g.user_id = ? " +
			"ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary",
		).bind(userId),
		env.DB.prepare(
			"INSERT INTO records (id, user_id, project_id, type, title, summary, body_ref, tags, created_at, updated_at) " +
			"SELECT 'site:' || s.slug, s.user_id, s.outcome_id, 'deliverable', s.title, 'Website, ' || s.status, '/s/' || s.slug, 'website', " +
			"COALESCE(CAST(strftime('%s', s.created_at) AS INTEGER) * 1000, 0), " + NOW + " FROM sites s WHERE s.user_id = ? " +
			"ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary, project_id = excluded.project_id",
		).bind(userId),
		env.DB.prepare("DELETE FROM records WHERE user_id = ? AND body_ref LIKE 'saved_nodes:%' AND NOT EXISTS (SELECT 1 FROM saved_nodes n WHERE n.id = substr(records.body_ref, 13))").bind(userId),
		env.DB.prepare("DELETE FROM records WHERE user_id = ? AND body_ref LIKE 'node_groups:%' AND NOT EXISTS (SELECT 1 FROM node_groups g WHERE g.id = substr(records.body_ref, 13))").bind(userId),
		env.DB.prepare("DELETE FROM records WHERE user_id = ? AND body_ref LIKE '/s/%' AND NOT EXISTS (SELECT 1 FROM sites s WHERE '/s/' || s.slug = records.body_ref)").bind(userId),
	]);
	const threads = refileThreads ? await refileThreads(env, userId) : 0;
	// External-content FTS5: 'rebuild' re-reads every row of records, so the index cannot hold anything stale or miss anything.
	await env.DB.prepare("INSERT INTO records_fts (records_fts) VALUES ('rebuild')").run();
	return { ...(await recordStats(env, userId)), conversations_refiled: threads };
}

// What the index holds for this user: records by type, the total, and and whether the full-text index agrees with them.
export async function recordStats(env, userId) {
	const { results } = await env.DB.prepare("SELECT type, COUNT(*) AS n FROM records WHERE user_id = ? GROUP BY type ORDER BY type").bind(userId).all();
	const by_type = Object.fromEntries((results || []).map(r => [r.type, r.n]));
	const total = Object.values(by_type).reduce((sum, n) => sum + n, 0);
	// FTS5's own check that the index and the table agree (it throws when a row is missing from the index or stale in it).
	const indexConsistent = await env.DB.prepare("INSERT INTO records_fts (records_fts, rank) VALUES ('integrity-check', 1)").run().then(() => true, () => false);
	return { total, by_type, index_consistent: indexConsistent };
}
