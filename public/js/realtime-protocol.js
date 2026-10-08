// The realtime wire format, defined once (PHASE2_PLAN.md sections 2.2 and 2.4). The Worker's UserHub and the browser's
// realtime.js both import this file, the same pattern as shell-surfaces.js. No dependencies, no I/O: every function is pure.
//
// Three kinds of message cross the socket:
//   server -> client  an event envelope (topic, type, seq), plus the control messages ready, gap and pong
//   client -> server  hello (resume point and topics), ack, ping
//   engine -> server  engine events without seq or at (the hub stamps them); only on an engine:push connection
// Events carry ids and small hints, never content: a client refetches what it needs. All writes stay on the REST routes.

export const PROTOCOL_VERSION = 1;

// Limits shared by both sides, so a client can size itself to what the hub will accept.
export const MAX_MESSAGE_BYTES = 4096;
export const RING_MAX_EVENTS = 200;
export const RING_MAX_AGE_MS = 10 * 60 * 1000;
export const MAX_CONNECTIONS_PER_USER = 8;
export const MAX_CLIENT_MESSAGES_PER_SECOND = 10;
// The engine is the source of truth; silent this long, the hub announces engine.bye.
export const ENGINE_SILENCE_MS = 60 * 1000;
// A question shown in the console or banner is cut to this many characters before it leaves the engine.
export const MAX_QUESTION_CHARS = 280;
export const MAX_ID_CHARS = 128;
export const MAX_REASON_CHARS = 280;

export const TOPICS = ['graph', 'engine', 'settings', 'system'];

// The nine graph types keep the names src/graph-events.js uses today, settings.updated included, so dual publish (R2) is a
// straight copy. The settings and system topics are reserved: no types yet, and the validator refuses unknown ones.
export const GRAPH_EVENT_TYPES = [
	'node.created', 'node.updated', 'node.deleted',
	'link.created', 'link.updated', 'link.deleted',
	'group.updated', 'settings.updated', 'graph.changed',
];

export const AGENT_STATES = ['ACTIVE', 'HALTED'];
export const TASK_STATUSES = ['queued', 'running', 'awaiting', 'done', 'failed', 'cancelled'];

// Engine event types and the data each one must carry. 'id' fields are short strings; 'int' is a non-negative integer.
const ID = 'id';
const INT = 'int';
const ENGINE_SCHEMAS = {
	'agent.state': { required: { agent_id: ID, state: AGENT_STATES }, optional: { reason: 'text' } },
	'task.started': { required: { task_id: ID, agent_id: ID, status: TASK_STATUSES }, optional: { total_steps: INT } },
	'task.step': { required: { task_id: ID, agent_id: ID, status: TASK_STATUSES, completed_steps: INT, total_steps: INT }, optional: {} },
	'task.finished': { required: { task_id: ID, agent_id: ID, status: TASK_STATUSES }, optional: { completed_steps: INT, total_steps: INT } },
	'task.awaiting': { required: { task_id: ID, agent_id: ID, question: 'question' }, optional: {} },
	'task.choice': { required: { task_id: ID, option: ID }, optional: {} },
	'engine.hello': { required: { version: ID }, optional: { capabilities: 'capabilities' } },
	'engine.bye': { required: {}, optional: { reason: 'text' } },
};
export const ENGINE_EVENT_TYPES = Object.keys(ENGINE_SCHEMAS);

export const EVENT_TYPES = {
	graph: GRAPH_EVENT_TYPES,
	engine: ENGINE_EVENT_TYPES,
	settings: [],
	system: [],
};

// Control messages the hub sends that are not events (no seq of their own).
export const SERVER_CONTROL_TYPES = ['ready', 'gap', 'pong'];
export const CLIENT_MESSAGE_TYPES = ['hello', 'ack', 'ping'];

// ---- Helpers -------------------------------------------------------------------------------------------------------

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = (value) => Number.isSafeInteger(value) && value >= 0;
const isShortString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isIsoTime = (value) => typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

// The byte length of a string as UTF-8, without TextEncoder so the module runs anywhere.
export function byteLength(text) {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

// Cuts a question for the wire, ending in an ellipsis when it was shortened. Whitespace is collapsed first.
export function truncateQuestion(text) {
	const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
	return clean.length <= MAX_QUESTION_CHARS ? clean : clean.slice(0, MAX_QUESTION_CHARS - 1).trimEnd() + '…';
}

// Parses one frame (a string) into a message. Frames over MAX_MESSAGE_BYTES are refused before parsing.
export function parseFrame(text) {
	if (typeof text !== 'string') return fail('not-text');
	if (byteLength(text) > MAX_MESSAGE_BYTES) return fail('too-large');
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return fail('not-json');
	}
	return isObject(value) ? ok(value) : fail('not-object');
}

function checkField(kind, value) {
	if (kind === ID) return isShortString(value, MAX_ID_CHARS);
	if (kind === INT) return Number.isSafeInteger(value) && value >= 0;
	if (kind === 'text') return typeof value === 'string' && value.length <= MAX_REASON_CHARS;
	if (kind === 'question') return typeof value === 'string' && value.length > 0 && value.length <= MAX_QUESTION_CHARS;
	if (kind === 'capabilities') return Array.isArray(value) && value.length <= 16 && value.every((item) => isShortString(item, 32));
	if (Array.isArray(kind)) return kind.includes(value);
	return false;
}

// Checks an engine event's data against its schema: required fields present and valid, optional ones valid if present,
// and no other keys (so nothing unreviewed, such as content, rides along).
export function validateEngineData(type, data) {
	const schema = ENGINE_SCHEMAS[type];
	if (!schema) return fail('unknown-type');
	if (!isObject(data)) return fail('bad-data');
	for (const [key, kind] of Object.entries(schema.required)) {
		if (!has(data, key)) return fail('missing-' + key);
		if (!checkField(kind, data[key])) return fail('bad-' + key);
	}
	for (const key of Object.keys(data)) {
		if (has(schema.required, key)) continue;
		if (!has(schema.optional, key)) return fail('unknown-' + key);
		if (!checkField(schema.optional[key], data[key])) return fail('bad-' + key);
	}
	if (type === 'task.step' && data.completed_steps > data.total_steps) return fail('bad-completed_steps');
	return ok(data);
}

// ---- Server -> client ----------------------------------------------------------------------------------------------

// An event as the hub stores and sends it: { v, seq, at, topic, type, id?, origin?, data? }.
export function validateEnvelope(message) {
	if (!isObject(message)) return fail('not-object');
	if (message.v !== PROTOCOL_VERSION) return fail('bad-version');
	if (!Number.isSafeInteger(message.seq) || message.seq < 1) return fail('bad-seq');
	if (!isIsoTime(message.at)) return fail('bad-at');
	if (!TOPICS.includes(message.topic)) return fail('bad-topic');
	if (!EVENT_TYPES[message.topic].includes(message.type)) return fail('bad-type');
	if (has(message, 'id') && !isShortString(message.id, MAX_ID_CHARS)) return fail('bad-id');
	if (has(message, 'origin') && message.origin !== null && !isShortString(message.origin, 64)) return fail('bad-origin');
	if (message.topic === 'engine') {
		const data = validateEngineData(message.type, message.data);
		if (!data.ok) return fail('data-' + data.error);
	} else if (has(message, 'data')) {
		return fail('unexpected-data');
	}
	return ok(message);
}

// Builds an envelope for a graph event (the shape graphEventFor returns: { type, id? }). origin is the tab that made the change.
export function graphEnvelope(seq, at, event, origin = null) {
	const envelope = { v: PROTOCOL_VERSION, seq, at, topic: 'graph', type: event.type };
	if (event.id) envelope.id = String(event.id);
	if (origin) envelope.origin = String(origin).slice(0, 64);
	return envelope;
}

// Builds an envelope for an engine event whose data already passed validateEngineData.
export function engineEnvelope(seq, at, type, data) {
	return { v: PROTOCOL_VERSION, seq, at, topic: 'engine', type, data };
}

// After a hello, the hub sends the missed events in order and then ready, so the client knows it is caught up.
export const readyMessage = (seq) => ({ v: PROTOCOL_VERSION, type: 'ready', seq });
// lastSeq is older than the ring: the client must refetch everything and never apply a partial patch across the gap.
export const gapMessage = (seq) => ({ v: PROTOCOL_VERSION, type: 'gap', seq });
export const pongMessage = () => ({ v: PROTOCOL_VERSION, type: 'pong' });

// What the client does with a message from the hub: 'event', 'ready', 'gap' or 'pong'.
export function validateServerMessage(message) {
	if (!isObject(message)) return fail('not-object');
	if (message.v !== PROTOCOL_VERSION) return fail('bad-version');
	if (message.type === 'pong') return ok({ kind: 'pong', message });
	if (message.type === 'ready' || message.type === 'gap') {
		return isSeq(message.seq) ? ok({ kind: message.type, message }) : fail('bad-seq');
	}
	const envelope = validateEnvelope(message);
	return envelope.ok ? ok({ kind: 'event', message }) : envelope;
}

// ---- Client -> server ----------------------------------------------------------------------------------------------

export const helloMessage = (lastSeq, topics) => ({ v: PROTOCOL_VERSION, type: 'hello', lastSeq, topics });
export const ackMessage = (seq) => ({ v: PROTOCOL_VERSION, type: 'ack', seq });
export const pingMessage = () => ({ v: PROTOCOL_VERSION, type: 'ping' });

// A message from a browser. lastSeq 0 means "nothing seen yet" (a first connection); topics are deduplicated and only
// topics with event types can be asked for.
export function validateClientMessage(message) {
	if (!isObject(message)) return fail('not-object');
	if (message.v !== PROTOCOL_VERSION) return fail('bad-version');
	if (message.type === 'ping') return ok({ type: 'ping' });
	if (message.type === 'ack') return isSeq(message.seq) ? ok({ type: 'ack', seq: message.seq }) : fail('bad-seq');
	if (message.type === 'hello') {
		if (!isSeq(message.lastSeq)) return fail('bad-lastSeq');
		if (!Array.isArray(message.topics) || message.topics.length === 0 || message.topics.length > TOPICS.length) return fail('bad-topics');
		const topics = [];
		for (const topic of message.topics) {
			if (!TOPICS.includes(topic) || EVENT_TYPES[topic].length === 0) return fail('bad-topics');
			if (!topics.includes(topic)) topics.push(topic);
		}
		return ok({ type: 'hello', lastSeq: message.lastSeq, topics });
	}
	return fail('unknown-type');
}

// ---- Engine -> server ----------------------------------------------------------------------------------------------

// An engine event on the push connection (option A): { v, topic: 'engine', type, data }. The hub adds seq and at. The same
// shape is the body of one item in a signed-POST batch (option B), so the choice between A and B changes the transport only.
export function validateEngineInput(message) {
	if (!isObject(message)) return fail('not-object');
	if (message.v !== PROTOCOL_VERSION) return fail('bad-version');
	if (message.topic !== 'engine') return fail('bad-topic');
	if (!ENGINE_EVENT_TYPES.includes(message.type)) return fail('bad-type');
	const data = validateEngineData(message.type, message.data);
	return data.ok ? ok({ type: message.type, data: data.value }) : fail('data-' + data.error);
}

// ---- Resume: the ring ----------------------------------------------------------------------------------------------

// The last RING_MAX_EVENTS events or RING_MAX_AGE_MS, whichever is smaller. Events are in seq order.
export function trimRing(events, now) {
	const cutoff = now - RING_MAX_AGE_MS;
	const recent = events.filter((event) => Date.parse(event.at) >= cutoff);
	return recent.length > RING_MAX_EVENTS ? recent.slice(recent.length - RING_MAX_EVENTS) : recent;
}

// What a hello gets back. 'replay' lists the events after lastSeq in order (possibly none); 'gap' means the client missed
// something the ring no longer holds and must refetch. headSeq is the newest seq the hub has issued (0 for a fresh hub).
// A lastSeq beyond headSeq means the hub lost its counter: that is a gap too, never silence.
export function resolveResume(ring, headSeq, lastSeq) {
	if (lastSeq > headSeq) return { kind: 'gap', seq: headSeq };
	if (lastSeq === headSeq) return { kind: 'replay', events: [], seq: headSeq };
	const oldest = ring.length ? ring[0].seq : headSeq + 1;
	// The first event the client lacks is lastSeq + 1; if the ring starts after that, something was dropped.
	if (oldest > lastSeq + 1) return { kind: 'gap', seq: headSeq };
	return { kind: 'replay', events: ring.filter((event) => event.seq > lastSeq), seq: headSeq };
}

// Only the topics a client asked for are delivered.
export const wantsEvent = (topics, event) => topics.includes(event.topic);

// ---- Reconnect schedule --------------------------------------------------------------------------------------------

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

// Delay before reconnect attempt `attempt` (0 is the first retry): exponential from 1 s to a 30 s cap, with "full jitter"
// (a random point between half the step and the whole step) so many tabs do not reconnect in lockstep. random is injectable.
export function backoffDelay(attempt, random = Math.random) {
	const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 16)));
	return Math.round(step / 2 + random() * (step / 2));
}
