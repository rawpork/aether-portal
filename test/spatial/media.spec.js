import { describe, expect, it } from "vitest";
import { isPlayable, parseMedia } from "../../public/js/spatial/media.js";

describe("parseMedia", () => {
	it("reads YouTube links in their usual shapes", () => {
		for (const url of [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x",
			"https://youtu.be/dQw4w9WgXcQ",
			"https://m.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://www.youtube.com/shorts/dQw4w9WgXcQ",
			"https://www.youtube.com/embed/dQw4w9WgXcQ",
			"https://www.youtube.com/live/dQw4w9WgXcQ",
		]) {
			const media = parseMedia(url);
			expect(media.kind).toBe("youtube");
			expect(media.id).toBe("dQw4w9WgXcQ");
			expect(media.embedUrl).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?autoplay=1&playsinline=1&rel=0$/);
		}
	});

	it("keeps a YouTube start time", () => {
		expect(parseMedia("https://youtu.be/dQw4w9WgXcQ?t=90").embedUrl).toContain("start=90");
		expect(parseMedia("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s").embedUrl).toContain("start=65");
	});

	it("reads Vimeo links, public and unlisted", () => {
		expect(parseMedia("https://vimeo.com/76979871")).toEqual({ kind: "vimeo", id: "76979871", embedUrl: "https://player.vimeo.com/video/76979871?autoplay=1" });
		expect(parseMedia("https://vimeo.com/76979871/abc123def0").embedUrl).toBe("https://player.vimeo.com/video/76979871?h=abc123def0&autoplay=1");
		expect(parseMedia("https://player.vimeo.com/video/76979871?h=abc123").embedUrl).toContain("h=abc123");
		expect(parseMedia("https://vimeo.com/channels/staffpicks/76979871").id).toBe("76979871");
	});

	it("plays direct video files", () => {
		expect(parseMedia("https://cdn.test/clip.MP4?sig=1")).toEqual({ kind: "file", src: "https://cdn.test/clip.MP4?sig=1" });
		expect(parseMedia("https://cdn.test/a/b.webm").kind).toBe("file");
	});

	it("leaves everything else to launch in a new tab", () => {
		for (const url of [
			"https://www.tiktok.com/@a/video/123",
			"https://x.com/i/status/1",
			"https://www.facebook.com/reel/1",
			"https://www.instagram.com/reel/abc",
			"https://example.com/article",
			"https://www.youtube.com/@channel",
			"https://www.youtube.com/watch?v=bad id",
			"javascript:alert(1)",
			"",
			null,
		]) {
			expect(isPlayable(url)).toBe(false);
		}
	});
});
