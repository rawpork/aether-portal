// Shared by the Elarion dock (brain-dock.js), the command bar (command-bar.js) and the spoken alerts (realtime-alerts.js):
// what each way the browser's voice features can fail says to the person, and the one step that makes spoken replies work on
// iPhones. Nothing here touches the page; every function is pure or takes what it needs.

export const NO_LISTEN_TEXT = 'Voice input needs a browser with speech recognition (Safari, Chrome or Edge). Type instead.';
export const NO_SPEAK_TEXT = 'This browser cannot speak replies.';

// SpeechRecognition's onerror codes. null means say nothing (the person or the page stopped it on purpose).
export function describeRecognitionError(code) {
	switch (code) {
		case 'not-allowed':
		case 'service-not-allowed':
			return 'The microphone or speech recognition is blocked. Allow the microphone for this site in your browser or phone settings, then tap the mic again.';
		case 'audio-capture':
			return 'No microphone was found, or another app is using it.';
		case 'network':
			return 'Speech recognition could not reach its service. Check your connection and try again.';
		case 'language-not-supported':
			return 'Speech recognition does not support your language setting.';
		case 'no-speech':
			return 'I did not hear anything. Tap the mic and try again.';
		case 'aborted':
			return null;
		default:
			return 'Speech recognition failed' + (code ? ' (' + code + ')' : '') + '. Type instead.';
	}
}

// getUserMedia / MediaRecorder failures, by the error's name.
export function describeMicError(error) {
	const name = (error && error.name) || '';
	if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
		return 'Microphone access was blocked. Allow it for this site in your browser or phone settings, then tap the mic again.';
	}
	if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.';
	if (name === 'NotReadableError' || name === 'TrackStartError') return 'The microphone is being used by another app.';
	if (name === 'NotSupportedError') return 'This browser cannot record audio in the format the engine needs. Type instead.';
	return 'Could not start the microphone' + (error && error.message ? ': ' + error.message : '.');
}

// iPhone Safari lets a page speak only after something has spoken from a tap. Speaking one silent utterance from the tap that
// asked for voice (the mic, or turning replies on) lets the replies, which arrive later, be heard. The utterance is marked so
// callers and tests can tell it from a real one. Returns whether anything was sent to the synthesizer.
export function primeSpeech(synth, Utterance) {
	if (!synth || !Utterance) return false;
	try {
		const utterance = new Utterance(' ');
		utterance.volume = 0;
		utterance.isPrime = true;
		synth.speak(utterance);
		return true;
	} catch {
		return false;
	}
}
