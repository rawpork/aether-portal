// Mission Control alerts from the realtime stream (Phase 10, R5): when an agent needs the operator, say so, wherever they are
// looking. Two channels, neither moves focus:
//   - the page's polite live region (announce() in a11y.js), always, for screen readers;
//   - the browser's speech synthesis, when voice replies are on (the same preference as the Elarion dock's speaker button,
//     aether.brain.speakReplies, on unless muted there).
// Alerts: task.awaiting ("Atlas is waiting for your answer: ...") and a breaker trip (agent.state HALTED, only on the change
// from a state we saw, so the snapshot a reconnecting engine sends does not repeat it). Events older than a minute (a hub
// replay after a reconnect) and ones already announced are skipped.

import { announce as pageAnnounce } from '../a11y.js';
import { agentName } from './labels.js';

export const SPEAK_PREFERENCE_KEY = 'aether.brain.speakReplies';
export const MAX_EVENT_AGE_MS = 60000;
const REMEMBER = 200;

function readPreference(storage) {
	try {
		return storage ? storage.getItem(SPEAK_PREFERENCE_KEY) !== 'false' : true;
	} catch {
		return true;
	}
}

// The words for an event, or null when it is not one to announce. known: the last state seen per agent.
export function alertText(event, known = new Map()) {
	if (!event || event.topic !== 'engine' || !event.data) return null;
	const data = event.data;
	if (event.type === 'task.awaiting') return agentName(data.agent_id) + ' is waiting for your answer: ' + data.question;
	if (event.type === 'agent.state') {
		const before = known.get(data.agent_id);
		known.set(data.agent_id, data.state);
		if (data.state === 'HALTED' && before && before !== 'HALTED') {
			return agentName(data.agent_id) + ' has been halted' + (data.reason ? ': ' + data.reason : '.');
		}
	}
	return null;
}

export function mountRealtimeAlerts(win, options = {}) {
	const announce = options.announce || pageAnnounce;
	const now = options.now || (() => Date.now());
	const synth = 'synth' in options ? options.synth : win.speechSynthesis || null;
	const Utterance = options.Utterance || win.SpeechSynthesisUtterance || null;
	let storage = null;
	try {
		storage = 'storage' in options ? options.storage : win.localStorage;
	} catch {
		storage = null;
	}
	const known = new Map();
	// Questions already announced, by task. Cleared when the task is answered or finishes, so a re-run asks out loud again, while
	// the snapshot a reconnecting engine resends (same task, same question) stays quiet.
	const asked = new Map();
	const seenSeqs = [];

	function speak(text) {
		if (!synth || !Utterance || !readPreference(storage)) return false;
		try {
			synth.speak(new Utterance(text));
			return true;
		} catch {
			return false;
		}
	}

	function onEvent(message) {
		const event = message.detail;
		if (!event || event.topic !== 'engine' || !event.data) return;
		if (event.type === 'task.choice' || event.type === 'task.finished') asked.delete(event.data.task_id);
		// Always track state changes (so a later trip is a change), but announce only fresh, unseen events.
		const text = alertText(event, known);
		if (!text) return;
		if (now() - Date.parse(event.at) > MAX_EVENT_AGE_MS) return;
		if (seenSeqs.includes(event.seq)) return;
		seenSeqs.push(event.seq);
		if (seenSeqs.length > REMEMBER) seenSeqs.shift();
		if (event.type === 'task.awaiting') {
			if (asked.get(event.data.task_id) === event.data.question) return;
			asked.set(event.data.task_id, event.data.question);
		}
		announce(text);
		speak(text);
	}

	win.addEventListener('aether-realtime-event', onEvent);
	return {
		stop() {
			win.removeEventListener('aether-realtime-event', onEvent);
		},
	};
}
