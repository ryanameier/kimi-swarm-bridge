import puppeteer from "@cloudflare/puppeteer";
import { effectiveAllowlist, egressMode, hostMatches } from "./egress";

/**
 * Headless rendering for pages that need JavaScript, via Cloudflare Browser
 * Rendering (included with Workers Paid; no extra account). Containers call
 * http://browser.internal/render?url=... and get back the page title and text.
 */

export const BROWSER_HOST = "browser.internal";
const MAX_TEXT_CHARS = 200_000;

export interface BrowserEnv {
	BROWSER?: Fetcher;
	EGRESS_MODE?: string;
	EGRESS_ALLOWLIST?: string;
}

export async function renderPage(request: Request, env: BrowserEnv): Promise<Response> {
	const target = new URL(request.url).searchParams.get("url") ?? "";
	let url: URL;
	try {
		url = new URL(target);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
	} catch {
		return Response.json({ error: "Pass an http(s) URL as ?url=" }, { status: 400 });
	}
	if (egressMode(env) === "allowlist" && !hostMatches(url.hostname, effectiveAllowlist(env))) {
		return Response.json({ error: `Outbound access to ${url.hostname} is not allowed by this deployment.` }, { status: 403 });
	}
	if (!env.BROWSER) return Response.json({ error: "Browser Rendering is not configured." }, { status: 501 });

	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: 30_000 });
		const title = await page.title();
		// Runs in the page, where `document` exists; typed loosely because the Worker has no DOM types.
		const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
		return Response.json({ title, text: text.slice(0, MAX_TEXT_CHARS) });
	} catch (error) {
		return Response.json({ error: `Rendering failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
	} finally {
		await browser.close();
	}
}
