// Context retrieval over the records table (migrations/0019_records.sql): the engine's two tools, search_records and get_record,
// plus the write that blueprints use to enter the index (cards, outcomes and websites are indexed by D1 triggers as they are saved).
// Every query is scoped to one user. Bodies are not stored here: body_ref points at where they live.

export const RECORDS_LIMIT_DEFAULT = 10;
export const RECORDS_LIMIT_MAX = 50;
export const RECORD_TYPES = ["card", "blueprint", "phase_output", "deliverable", "note", "run"];
const TEXT_MAX = 2000;
const ID_MAX = 200;
const COLUMNS = "r.id, r.project_id, r.run_id, r.type, r.title, r.summary, r.body_ref, r.tags, r.created_at, r.updated_at";

export function clampLimit(value) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 1) return RECORDS_LIMIT_DEFAULT;
	return Math.min(n, RECORDS_LIMIT_MAX);
}

// Free text to a safe FTS5 query: each word quoted (so operators and punctuation are plain text), the last one a prefix, all
// required. Returns null when there is nothing to search for.
export function toMatchQuery(text) {
	const words = String(text == null ? "" : text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
	if (!words.length) return null;
	return words.slice(0, 12).map((w, i, all) => '"' + w + '"' + (i === all.length - 1 ? "*" : "")).join(" ");
}

// search_records(query, project_id?, type?, limit): best matches first (bm25), or the most recent records when the query is empty.
export async function searchRecords(env, userId, { query, project_id, type, limit } = {}) {
	const match = toMatchQuery(query);
	const filters = [];
	const args = [];
	if (project_id) { filters.push("r.project_id = ?"); args.push(String(project_id)); }
	if (type) { filters.push("r.type = ?"); args.push(String(type)); }
	const extra = filters.length ? " AND " + filters.join(" AND ") : "";
	const max = clampLimit(limit);
	const statement = match
		? env.DB.prepare("SELECT " + COLUMNS + " FROM records_fts JOIN records r ON r.rowid = records_fts.rowid WHERE records_fts MATCH ? AND r.user_id = ?" + extra + " ORDER BY bm25(records_fts) LIMIT ?").bind(match, userId, ...args, max)
		: env.DB.prepare("SELECT " + COLUMNS + " FROM records r WHERE r.user_id = ?" + extra + " ORDER BY r.updated_at DESC LIMIT ?").bind(userId, ...args, max);
	const { results } = await statement.all();
	return { records: results || [], count: (results || []).length };
}

// get_record(id): the record, plus the body it points at when that is a saved card (its description, note and link).
export async function getRecord(env, userId, id) {
	const record = await env.DB.prepare("SELECT " + COLUMNS + " FROM records r WHERE r.id = ? AND r.user_id = ?").bind(String(id), userId).first();
	if (!record) return null;
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
