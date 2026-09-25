import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AIAND_PLACEHOLDER,
	egressMode,
	handleEgress,
	hostMatches,
	isModelRequest,
	type EgressEnv,
	type ModelBudgetResult,
} from "../src/egress";

function makeEnv(overrides: Partial<EgressEnv> = {}, budget: ModelBudgetResult = { allowed: true, used: 1, limit: 0 }) {
	const consumeModelRequest = vi.fn(async () => budget);
	const idFromString = vi.fn((id: string) => id);
	const env = {
		AIAND_API_KEY: "real-aiand-key",
		FIRECRAWL_API_KEY: "real-firecrawl-key",
		KIMI_SANDBOX: { idFromString, get: () => ({ consumeModelRequest }) } as unknown as DurableObjectNamespace,
		...overrides,
	} satisfies EgressEnv;
	return { env, consumeModelRequest, idFromString };
}

const chat = (headers: Record<string, string> = { authorization: `Bearer ${AIAND_PLACEHOLDER}` }) =>
	new Request("https://api.aiand.com/v1/chat/completions", { method: "POST", headers, body: "{}" });

let upstream: Request[] = [];
function stubFetch() {
	upstream = [];
	vi.stubGlobal("fetch", async (request: Request) => {
		upstream.push(request);
		return new Response("upstream");
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("egress policy helpers", () => {
	it("defaults to open for unknown modes", () => {
		expect(egressMode({})).toBe("open");
		expect(egressMode({ EGRESS_MODE: " LOG " })).toBe("log");
		expect(egressMode({ EGRESS_MODE: "allowlist" })).toBe("allowlist");
		expect(egressMode({ EGRESS_MODE: "closed" })).toBe("open");
	});

	it("matches exact hosts and globs", () => {
		expect(hostMatches("github.com", ["github.com"])).toBe(true);
		expect(hostMatches("api.github.com", ["*.github.com"])).toBe(true);
		expect(hostMatches("github.com", ["*.github.com"])).toBe(true);
		expect(hostMatches("evilgithub.com", ["*.github.com"])).toBe(false);
		expect(hostMatches("github.com.evil.net", ["github.com"])).toBe(false);
		expect(hostMatches("pypi.org", ["*"])).toBe(true);
	});

	it("counts only model calls", () => {
		expect(isModelRequest(chat())).toBe(true);
		expect(isModelRequest(new Request("https://api.aiand.com/v1/models"))).toBe(false);
		expect(isModelRequest(new Request("https://api.firecrawl.dev/v2/scrape", { method: "POST" }))).toBe(false);
	});
});

describe("handleEgress", () => {
	const props = { containerId: "do-id-1" };
	const direct = vi.fn(async (_request: Request) => new Response("direct"));

	it("replaces the placeholder with the real ai& key and counts the request", async () => {
		stubFetch();
		const { env, consumeModelRequest, idFromString } = makeEnv();
		const response = await handleEgress(chat(), env, props, direct);
		expect(await response.text()).toBe("upstream");
		expect(upstream[0].headers.get("authorization")).toBe("Bearer real-aiand-key");
		expect(consumeModelRequest).toHaveBeenCalledTimes(1);
		expect(idFromString).toHaveBeenCalledWith("do-id-1");
	});

	it("attaches the Firecrawl key without counting it", async () => {
		stubFetch();
		const { env, consumeModelRequest } = makeEnv();
		await handleEgress(new Request("https://api.firecrawl.dev/v2/scrape", { method: "POST", body: "{}" }), env, props, direct);
		expect(upstream[0].headers.get("authorization")).toBe("Bearer real-firecrawl-key");
		expect(consumeModelRequest).not.toHaveBeenCalled();
	});

	it("blocks model calls over the daily budget with a quota error", async () => {
		stubFetch();
		const { env } = makeEnv({}, { allowed: false, used: 10, limit: 10 });
		const response = await handleEgress(chat(), env, props, direct);
		expect(response.status).toBe(402);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe("insufficient_quota");
		expect(upstream).toHaveLength(0);
	});

	it("reports account-level upstream errors to admins", async () => {
		vi.stubGlobal("fetch", async () => new Response("{}", { status: 402 }));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { env } = makeEnv();
		const response = await handleEgress(chat(), env, props, direct);
		expect(response.status).toBe(402);
		expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({ event: "egress-upstream-error", host: "api.aiand.com", status: 402 });
	});

	it("never forwards a disabled Firecrawl key", async () => {
		stubFetch();
		const { env } = makeEnv({ FIRECRAWL_API_KEY: "disabled" });
		await handleEgress(new Request("https://api.firecrawl.dev/v2/scrape"), env, props, direct);
		expect(upstream).toHaveLength(0);
		expect(direct).toHaveBeenCalled();
	});

	it("passes other hosts through silently in open mode", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { env } = makeEnv();
		const response = await handleEgress(new Request("https://pypi.org/simple/"), env, props, direct);
		expect(await response.text()).toBe("direct");
		expect(log).not.toHaveBeenCalled();
	});

	it("logs outbound hosts in log mode", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { env } = makeEnv({ EGRESS_MODE: "log" });
		await handleEgress(new Request("https://pypi.org/simple/"), env, props, direct);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
			event: "egress",
			sandbox: "do-id-1",
			host: "pypi.org",
			method: "GET",
			action: "allowed",
		});
	});

	it("blocks unlisted hosts in allowlist mode but keeps credential hosts reachable", async () => {
		stubFetch();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { env } = makeEnv({ EGRESS_MODE: "allowlist", EGRESS_ALLOWLIST: "*.github.com, pypi.org" });
		expect((await handleEgress(new Request("https://example.com/"), env, props, direct)).status).toBe(403);
		expect(await (await handleEgress(new Request("https://codeload.github.com/x"), env, props, direct)).text()).toBe("direct");
		expect(await (await handleEgress(chat(), env, props, direct)).text()).toBe("upstream");
	});
});
