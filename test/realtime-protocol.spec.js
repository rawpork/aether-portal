import { describe, expect, it } from "vitest";
import { GRAPH_EVENT_TYPES as LIVE_GRAPH_EVENT_TYPES, graphEventFor } from "../src/graph-events.js";
import {
	ENGINE_EVENT_TYPES,
	GRAPH_EVENT_TYPES,
	MAX_MESSAGE_BYTES,
	MAX_QUESTION_CHARS,
	RING_MAX_AGE_MS,
	RING_MAX_EVENTS,
	ackMessage,
	backoffDelay,
	byteLength,
	engineEnvelope,
	gapMessage,
	graphEnvelope,
	helloMessage,
	parseFrame,
	pingMessage,
	pongMessage,
	readyMessage,
	resolveResume,
	trimRing,
	truncateQuestion,
	validateClientMessage,
	validateEngineData,
	validateEngineInput,
	validateEnvelope,
	validateServerMessage,
	wantsEvent,
} from "../public/js/realtime-protocol.js";

const AT = "2026-10-07T12:00:00.000Z";
const graph = (seq, type = "node.updated", extra = {}) => ({ v: 1, seq, at: AT, topic: "graph", type, ...extra });
const ring = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => graph(from + i));

describe("graph events", () => {
	it("keep the nine types the SSE stream uses today", () => {
		expect(GRAPH_EVENT_TYPES).toEqual(LIVE_GRAPH_EVENT_TYPES);
	});

	it("accept everything graphEventFor can produce", () => {
		const writes = [
			["POST", "/api/node"], ["PATCH", "/api/node/n1"], ["DELETE", "/api/node/n1"], ["POST", "/api/link"],
			["PATCH", "/api/link"], ["DELETE", "/api/link"], ["POST", "/api/groups"], ["PATCH", "/api/settings"], ["POST", "/api/ask"],
		];
		writes.forEach(([method, path], i) => {
			const event = graphEventFor(method, path);
			expect(validateEnvelope(graphEnvelope(i + 1, AT, event, "tab_9f3")).ok).toBe(true);
		});
	});

	it("build the documented envelope", () => {
		expect(graphEnvelope(1042, AT, { type: "node.updated", id: "node_ab12" }, "tab_9f3")).toEqual({
			v: 1, seq: 1042, at: AT, topic: "graph", type: "node.updated", id: "node_ab12", origin: "tab_9f3",
		});
		expect(graphEnvelope(1, AT, { type: "node.created" })).toEqual({ v: 1, seq: 1, at: AT, topic: "graph", type: "node.created" });
	});
});

describe("validateEnvelope", () => {
	it("accepts a well-formed event", () => {
		expect(validateEnvelope(graph(7, "link.created")).ok).toBe(true);
	});

	it.each([
		["a wrong version", { v: 2 }, "bad-version"],
		["seq 0", { seq: 0 }, "bad-seq"],
		["a fractional seq", { seq: 1.5 }, "bad-seq"],
		["a non-ISO time", { at: "yesterday" }, "bad-at"],
		["a local time", { at: "2026-10-07T12:00:00+02:00" }, "bad-at"],
		["an unknown topic", { topic: "chat" }, "bad-topic"],
		["a type from another topic", { type: "agent.state" }, "bad-type"],
		["an empty id", { id: "" }, "bad-id"],
		["an oversized origin", { origin: "x".repeat(65) }, "bad-origin"],
		["data on a graph event", { data: {} }, "unexpected-data"],
	])("rejects %s", (_, patch, error) => {
		expect(validateEnvelope({ ...graph(1), ...patch })).toEqual({ ok: false, error });
	});

	it("rejects non-objects", () => {
		for (const value of [null, 3, "x", []]) expect(validateEnvelope(value).ok).toBe(false);
	});

	it("keeps settings and system reserved: no types yet", () => {
		expect(validateEnvelope({ ...graph(1), topic: "settings", type: "settings.updated" }).ok).toBe(false);
		expect(validateEnvelope({ ...graph(1), topic: "system", type: "notice" }).ok).toBe(false);
	});
});

describe("engine events", () => {
	const valid = {
		"agent.state": { agent_id: "master-brain", state: "HALTED", reason: "Paused from Mission Control" },
		"task.started": { task_id: "t1", agent_id: "a1", status: "running", total_steps: 5 },
		"task.step": { task_id: "t1", agent_id: "a1", status: "running", completed_steps: 2, total_steps: 5 },
		"task.finished": { task_id: "t1", agent_id: "a1", status: "done", completed_steps: 5, total_steps: 5 },
		"task.awaiting": { task_id: "t1", agent_id: "a1", question: "Deploy to production?" },
		"task.choice": { task_id: "t1", option: "yes" },
		"engine.hello": { version: "1.4.0", capabilities: ["tasks", "approvals"] },
		"engine.bye": { reason: "silent for 60 s" },
	};

	it("has a sample for every type the plan lists", () => {
		expect(Object.keys(valid).sort()).toEqual([...ENGINE_EVENT_TYPES].sort());
	});

	it.each(Object.entries(valid))("accepts a valid %s in an envelope and as engine input", (type, data) => {
		expect(validateEnvelope(engineEnvelope(3, AT, type, data)).ok).toBe(true);
		expect(validateEngineInput({ v: 1, topic: "engine", type, data })).toEqual({ ok: true, value: { type, data } });
	});

	it("requires the fields each type needs", () => {
		expect(validateEngineData("agent.state", { agent_id: "a1" })).toEqual({ ok: false, error: "missing-state" });
		expect(validateEngineData("task.awaiting", { task_id: "t", agent_id: "a" })).toEqual({ ok: false, error: "missing-question" });
	});

	it("refuses bad values", () => {
		expect(validateEngineData("agent.state", { agent_id: "a", state: "PAUSED" }).error).toBe("bad-state");
		expect(validateEngineData("task.started", { task_id: "t", agent_id: "a", status: "running", total_steps: -1 }).error).toBe("bad-total_steps");
		expect(validateEngineData("task.step", { task_id: "t", agent_id: "a", status: "running", completed_steps: 6, total_steps: 5 }).error).toBe("bad-completed_steps");
		expect(validateEngineData("task.awaiting", { task_id: "t", agent_id: "a", question: "x".repeat(MAX_QUESTION_CHARS + 1) }).error).toBe("bad-question");
	});

	it("refuses keys outside the schema, so content cannot ride along", () => {
		expect(validateEngineData("task.choice", { task_id: "t", option: "yes", transcript: "..." }).error).toBe("unknown-transcript");
		expect(validateEngineData("task.choice", { task_id: "t", option: "yes", constructor: "x" }).error).toBe("unknown-constructor");
		expect(validateEngineData("engine.bye", { toString: "x" }).error).toBe("unknown-toString");
	});

	it("requires engine data on engine envelopes", () => {
		const bare = { v: 1, seq: 1, at: AT, topic: "engine", type: "engine.bye" };
		expect(validateEnvelope(bare)).toEqual({ ok: false, error: "data-bad-data" });
	});

	it("refuses engine input with a graph topic or type", () => {
		expect(validateEngineInput({ v: 1, topic: "graph", type: "node.created" }).error).toBe("bad-topic");
		expect(validateEngineInput({ v: 1, topic: "engine", type: "node.created", data: {} }).error).toBe("bad-type");
	});
});

describe("truncateQuestion", () => {
	it("collapses whitespace and leaves short text alone", () => {
		expect(truncateQuestion("  Deploy\n  to   prod? ")).toBe("Deploy to prod?");
	});

	it("cuts long text to the limit with an ellipsis", () => {
		const cut = truncateQuestion("word ".repeat(200));
		expect(cut.length).toBeLessThanOrEqual(MAX_QUESTION_CHARS);
		expect(cut.endsWith("…")).toBe(true);
	});

	it("treats null as empty", () => {
		expect(truncateQuestion(null)).toBe("");
	});
});

describe("client messages", () => {
	it("accepts hello, ack and ping", () => {
		expect(validateClientMessage(helloMessage(1041, ["graph", "engine"]))).toEqual({ ok: true, value: { type: "hello", lastSeq: 1041, topics: ["graph", "engine"] } });
		expect(validateClientMessage(helloMessage(0, ["graph"])).ok).toBe(true);
		expect(validateClientMessage(ackMessage(12))).toEqual({ ok: true, value: { type: "ack", seq: 12 } });
		expect(validateClientMessage(pingMessage())).toEqual({ ok: true, value: { type: "ping" } });
	});

	it("deduplicates topics", () => {
		expect(validateClientMessage(helloMessage(5, ["graph", "graph"])).value.topics).toEqual(["graph"]);
	});

	it.each([
		["a missing lastSeq", { v: 1, type: "hello", topics: ["graph"] }, "bad-lastSeq"],
		["a negative lastSeq", helloMessage(-1, ["graph"]), "bad-lastSeq"],
		["no topics", helloMessage(0, []), "bad-topics"],
		["an unknown topic", helloMessage(0, ["chat"]), "bad-topics"],
		["a reserved topic", helloMessage(0, ["system"]), "bad-topics"],
		["a topic that is not an array", { v: 1, type: "hello", lastSeq: 0, topics: "graph" }, "bad-topics"],
		["an ack without seq", { v: 1, type: "ack" }, "bad-seq"],
		["an unknown type", { v: 1, type: "write" }, "unknown-type"],
		["a wrong version", { v: 9, type: "ping" }, "bad-version"],
	])("rejects %s", (_, message, error) => {
		expect(validateClientMessage(message)).toEqual({ ok: false, error });
	});

	it("has no message that writes data: the client vocabulary is hello, ack and ping", () => {
		for (const type of ["create", "update", "delete", "patch", "publish", "event"]) {
			expect(validateClientMessage({ v: 1, type }).ok).toBe(false);
		}
	});
});

describe("server messages", () => {
	it("tells events from control messages", () => {
		expect(validateServerMessage(graph(2)).value.kind).toBe("event");
		expect(validateServerMessage(readyMessage(9)).value.kind).toBe("ready");
		expect(validateServerMessage(gapMessage(9)).value.kind).toBe("gap");
		expect(validateServerMessage(pongMessage()).value.kind).toBe("pong");
	});

	it("carries engine presence on ready only while the engine is online", () => {
		expect(readyMessage(9)).toEqual({ v: 1, type: "ready", seq: 9 });
		expect(readyMessage(9, false)).toEqual({ v: 1, type: "ready", seq: 9 });
		expect(readyMessage(9, true)).toEqual({ v: 1, type: "ready", seq: 9, engine: true });
		expect(validateServerMessage(readyMessage(9, true)).ok).toBe(true);
		for (const engine of [false, "yes", 1, null]) expect(validateServerMessage({ ...readyMessage(9), engine }).error).toBe("bad-engine");
	});

	it("rejects a ready without a seq and junk", () => {
		expect(validateServerMessage({ v: 1, type: "ready" }).ok).toBe(false);
		expect(validateServerMessage({ v: 1, type: "nope" }).ok).toBe(false);
		expect(validateServerMessage(null).ok).toBe(false);
	});
});

describe("parseFrame", () => {
	it("parses a JSON object", () => {
		expect(parseFrame('{"v":1,"type":"ping"}')).toEqual({ ok: true, value: { v: 1, type: "ping" } });
	});

	it("refuses non-text, bad JSON and non-objects", () => {
		expect(parseFrame(new ArrayBuffer(2)).error).toBe("not-text");
		expect(parseFrame("{").error).toBe("not-json");
		expect(parseFrame("[1]").error).toBe("not-object");
		expect(parseFrame("null").error).toBe("not-object");
	});

	it("refuses frames over the byte limit, counted in UTF-8", () => {
		const text = JSON.stringify({ v: 1, pad: "é".repeat(MAX_MESSAGE_BYTES / 2) });
		expect(text.length).toBeLessThan(MAX_MESSAGE_BYTES);
		expect(byteLength(text)).toBeGreaterThan(MAX_MESSAGE_BYTES);
		expect(parseFrame(text).error).toBe("too-large");
	});
});

describe("byteLength", () => {
	it("matches TextEncoder", () => {
		const encoder = new TextEncoder();
		for (const text of ["", "abc", "é", "€", "😀", "a😀é€"]) expect(byteLength(text)).toBe(encoder.encode(text).length);
	});
});

describe("ring", () => {
	const t0 = Date.parse(AT);

	it("trims to the newest 200 events", () => {
		const events = ring(1, 250);
		const kept = trimRing(events, t0);
		expect(kept).toHaveLength(RING_MAX_EVENTS);
		expect(kept[0].seq).toBe(51);
		expect(kept.at(-1).seq).toBe(250);
	});

	it("drops events older than 10 minutes", () => {
		const old = graph(1, "node.updated", { at: new Date(t0 - RING_MAX_AGE_MS - 1).toISOString() });
		const edge = graph(2, "node.updated", { at: new Date(t0 - RING_MAX_AGE_MS).toISOString() });
		expect(trimRing([old, edge, graph(3)], t0).map((e) => e.seq)).toEqual([2, 3]);
	});

	it("replays only what the client lacks, in order", () => {
		expect(resolveResume(ring(1, 10), 10, 7)).toEqual({ kind: "replay", events: ring(8, 10), seq: 10 });
	});

	it("replays nothing when the client is current, even with an empty ring", () => {
		expect(resolveResume(ring(1, 10), 10, 10)).toEqual({ kind: "replay", events: [], seq: 10 });
		expect(resolveResume([], 10, 10)).toEqual({ kind: "replay", events: [], seq: 10 });
		expect(resolveResume([], 0, 0)).toEqual({ kind: "replay", events: [], seq: 0 });
	});

	it("resumes exactly at the oldest edge of the ring", () => {
		expect(resolveResume(ring(5, 10), 10, 4).kind).toBe("replay");
		expect(resolveResume(ring(5, 10), 10, 4).events).toHaveLength(6);
	});

	it("reports a gap when the ring no longer holds what the client missed", () => {
		expect(resolveResume(ring(5, 10), 10, 3)).toEqual({ kind: "gap", seq: 10 });
		expect(resolveResume([], 10, 4)).toEqual({ kind: "gap", seq: 10 });
	});

	it("reports a gap when the client is ahead of a hub that lost its counter", () => {
		expect(resolveResume([], 0, 57)).toEqual({ kind: "gap", seq: 0 });
	});

	it("a first connection (lastSeq 0) on a busy hub is a gap, on a fresh hub it is current", () => {
		expect(resolveResume(ring(5, 10), 10, 0).kind).toBe("gap");
		expect(resolveResume([], 0, 0).kind).toBe("replay");
	});
});

describe("wantsEvent", () => {
	it("delivers only the topics asked for", () => {
		expect(wantsEvent(["graph"], graph(1))).toBe(true);
		expect(wantsEvent(["graph"], engineEnvelope(2, AT, "engine.bye", {}))).toBe(false);
	});
});

describe("backoffDelay", () => {
	it("doubles from one second to a 30 second cap", () => {
		const top = () => 1; // jitter at its maximum: the full step
		expect([0, 1, 2, 3, 4, 5, 6, 20].map((attempt) => backoffDelay(attempt, top))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
	});

	it("jitters between half the step and the whole step", () => {
		expect(backoffDelay(3, () => 0)).toBe(4000);
		expect(backoffDelay(3, () => 0.5)).toBe(6000);
		for (let i = 0; i < 50; i++) {
			const delay = backoffDelay(2);
			expect(delay).toBeGreaterThanOrEqual(2000);
			expect(delay).toBeLessThanOrEqual(4000);
		}
	});

	it("treats a negative attempt as the first", () => {
		expect(backoffDelay(-3, () => 1)).toBe(1000);
	});
});
