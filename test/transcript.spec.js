import { describe, it, expect } from "vitest";
import { TRANSCRIPT_MAX_CHARS, buildTranscriptSynopsisPrompt, buildVideoSynopsisPrompt, parseTranscriptXml, pickCaptionTrack } from "../src/transcript.js";

describe("parseTranscriptXml", () => {
	it("reads format 1 captions, whose text is escaped twice", () => {
		const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1.36" dur="1.68">[Music]</text><text start="18.64" dur="3.24">We&amp;#39;re no strangers
to love</text><text start="22" dur="1"> </text></transcript>`;
		expect(parseTranscriptXml(xml)).toBe("[Music]\nWe're no strangers to love");
	});

	it("reads format 3 captions and joins per-word spans", () => {
		const xml = `<timedtext format="3"><body><p t="1360" d="1680">Tom &amp; Jerry</p><p t="2000" d="900" w="1"><s ac="0">auto</s><s t="200" ac="0"> generated</s><s t="400"> words</s></p><p t="3000" d="10" a="1">
</p></body></timedtext>`;
		expect(parseTranscriptXml(xml)).toBe("Tom & Jerry\nauto generated words");
	});

	it("returns an empty string for missing or caption-less input", () => {
		for (const value of [null, "", "<transcript></transcript>", "not xml"]) {
			expect(parseTranscriptXml(value), String(value)).toBe("");
		}
	});
});

describe("pickCaptionTrack", () => {
	const track = (languageCode, kind) => ({ languageCode, kind, baseUrl: "https://example.com/" + languageCode + (kind || "") });

	it("prefers hand-made English, then auto English, then other hand-made captions", () => {
		expect(pickCaptionTrack([track("de"), track("en", "asr"), track("en-GB")])).toEqual(track("en-GB"));
		expect(pickCaptionTrack([track("de"), track("en", "asr")])).toEqual(track("en", "asr"));
		expect(pickCaptionTrack([track("ja", "asr"), track("de")])).toEqual(track("de"));
		expect(pickCaptionTrack([track("ja", "asr")])).toEqual(track("ja", "asr"));
	});

	it("skips tracks without a URL and handles no tracks", () => {
		expect(pickCaptionTrack([{ languageCode: "en" }, track("fr")])).toEqual(track("fr"));
		for (const value of [undefined, null, [], [null]]) {
			expect(pickCaptionTrack(value), String(value)).toBeNull();
		}
	});
});

describe("synopsis prompts", () => {
	it("includes the title and the transcript", () => {
		const prompt = buildTranscriptSynopsisPrompt("Intro to D1", "line one\nline two");
		expect(prompt).toContain("Title: Intro to D1");
		expect(prompt).toContain("Transcript:\nline one\nline two");
	});

	it("clips long transcripts and says so", () => {
		const prompt = buildTranscriptSynopsisPrompt("", "x".repeat(TRANSCRIPT_MAX_CHARS));
		expect(prompt).toContain("Title: (untitled)");
		expect(prompt).toContain("first part only");
		expect(prompt.length).toBeLessThan(TRANSCRIPT_MAX_CHARS);
	});

	it("asks for a synopsis of the attached video when there is no transcript", () => {
		const prompt = buildVideoSynopsisPrompt("Talk");
		expect(prompt).toContain("Summarize this YouTube video.");
		expect(prompt).toContain("Title: Talk");
		expect(prompt).not.toContain("Transcript");
	});
});
