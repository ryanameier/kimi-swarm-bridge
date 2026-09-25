import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({
	default: {
		launch: vi.fn(async () => ({
			newPage: async () => ({
				goto: async () => {},
				title: async () => "Example Domain",
				evaluate: async () => "Example Domain\nThis domain is for use in examples.",
			}),
			close: async () => {},
		})),
	},
}));

const { renderPage } = await import("../src/browser");
const req = (url: string) => new Request(`http://browser.internal/render?url=${encodeURIComponent(url)}`);

describe("renderPage", () => {
	it("returns the rendered title and text", async () => {
		const response = await renderPage(req("https://example.com"), { BROWSER: {} as Fetcher });
		expect(await response.json()).toEqual({ title: "Example Domain", text: "Example Domain\nThis domain is for use in examples." });
	});

	it("rejects non-http URLs, respects the allowlist and needs the binding", async () => {
		expect((await renderPage(req("file:///etc/passwd"), { BROWSER: {} as Fetcher })).status).toBe(400);
		expect((await renderPage(req("https://evil.example"), { BROWSER: {} as Fetcher, EGRESS_MODE: "allowlist", EGRESS_ALLOWLIST: "github.com" })).status).toBe(403);
		expect((await renderPage(req("https://example.com"), {})).status).toBe(501);
	});
});
