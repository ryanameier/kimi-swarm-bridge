import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AIAND_PLACEHOLDER,
	fetchWithFirstByteTimeout,
	whenBodyDone,
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
		BRAVE_API_KEY: "real-brave-key",
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
		expect(isModelRequest(new Request("https://api.search.brave.com/res/v1/web/search?q=x"))).toBe(false);
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

	it("attaches the Brave key as a subscription token without counting it", async () => {
		stubFetch();
		const { env, consumeModelRequest } = makeEnv();
		await handleEgress(new Request("https://api.search.brave.com/res/v1/web/search?q=x", { headers: { "x-subscription-token": "placeholder" } }), env, props, direct);
		expect(upstream[0].headers.get("x-subscription-token")).toBe("real-brave-key");
		expect(upstream[0].headers.get("authorization")).toBeNull();
		expect(consumeModelRequest).not.toHaveBeenCalled();
	});

	it("retries search requests on 429 so workers never sleep", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return calls < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) : new Response("results");
		});
		const waits: number[] = [];
		const { env } = makeEnv();
		const response = await handleEgress(new Request("https://api.search.brave.com/res/v1/web/search?q=x"), env, props, direct, async (ms) => {
			waits.push(ms);
		});
		expect(await response.text()).toBe("results");
		expect(waits).toEqual([1000, 1000]);
	});

	it("does not retry model requests (Kimi backs off itself)", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return new Response("limited", { status: 429 });
		});
		const { env } = makeEnv();
		expect((await handleEgress(chat(), env, props, direct, async () => {})).status).toBe(429);
		expect(calls).toBe(1);
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

	it("never forwards a disabled Brave key", async () => {
		stubFetch();
		const { env } = makeEnv({ BRAVE_API_KEY: "disabled" });
		await handleEgress(new Request("https://api.search.brave.com/res/v1/web/search?q=x"), env, props, direct);
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
			status: 200,
			ms: expect.any(Number),
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

describe("organization-wide ai& concurrency gate", () => {
	const props = { containerId: "do-id-1" };
	const direct = async () => new Response("direct");

	function gateEnv() {
		const calls: string[] = [];
		const gate = {
			acquire: vi.fn(async () => {
				calls.push("acquire");
				return { id: "l1", waitMs: 25 };
			}),
			release: vi.fn(async (id: string) => {
				calls.push(`release:${id}`);
			}),
		};
		const { env } = makeEnv({ AIAND_GATE: { idFromName: (name: string) => name, get: () => gate } as unknown as DurableObjectNamespace });
		return { env, gate, calls };
	}

	it("holds a slot for a model request until its response body has been read, and logs timing", async () => {
		stubFetch();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { env, gate, calls } = gateEnv();
		const response = await handleEgress(chat(), env, props, direct);
		expect(gate.acquire).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["acquire"]);
		expect(await response.text()).toBe("upstream");
		await vi.waitFor(() => expect(calls).toEqual(["acquire", "release:l1"]));
		const timing = log.mock.calls.map((c) => JSON.parse(c[0] as string)).find((e) => e.event === "timing");
		expect(timing).toMatchObject({ kind: "model", sandbox: "do-id-1", waitMs: 25, status: 200 });
	});

	it("keeps the invocation alive until the slot is released", async () => {
		stubFetch();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { env, calls } = gateEnv();
		const kept: Promise<unknown>[] = [];
		const response = await handleEgress(chat(), env, props, direct, undefined, (promise) => kept.push(promise));
		expect(kept).toHaveLength(1);
		await response.text();
		await Promise.all(kept);
		expect(calls).toEqual(["acquire", "release:l1"]);
	});

	it("releases the slot when the upstream request fails", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal("fetch", async () => {
			throw new Error("network down");
		});
		const { env, calls } = gateEnv();
		await expect(handleEgress(chat(), env, props, direct)).rejects.toThrow("network down");
		expect(calls).toEqual(["acquire", "release:l1"]);
	});

	it("does not gate searches or model listing", async () => {
		stubFetch();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { env, gate } = gateEnv();
		await handleEgress(new Request("https://api.aiand.com/v1/models"), env, props, direct);
		await handleEgress(new Request("https://api.search.brave.com/res/v1/web/search?q=x"), env, props, direct);
		expect(gate.acquire).not.toHaveBeenCalled();
	});
});

describe("model request timeouts", () => {
	it("cuts off a response that goes silent and reports it as stalled", async () => {
		let push!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start: (c) => { push = c; } });
		const outcomes: string[] = [];
		const kept: Promise<unknown>[] = [];
		const wrapped = whenBodyDone(new Response(body), (o) => { outcomes.push(o); }, (p) => kept.push(p), 20);
		push.enqueue(new TextEncoder().encode("data: 1\n\n"));
		const reader = wrapped.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
		await expect(reader.read()).rejects.toThrow("stalled");
		await Promise.all(kept);
		expect(outcomes).toEqual(["stalled"]);
	});

	it("passes a complete response through untouched", async () => {
		const outcomes: string[] = [];
		const kept: Promise<unknown>[] = [];
		const wrapped = whenBodyDone(new Response("full body"), (o) => { outcomes.push(o); }, (p) => kept.push(p), 1_000);
		expect(await wrapped.text()).toBe("full body");
		await Promise.all(kept);
		expect(outcomes).toEqual(["complete"]);
	});

	it("aborts a request that gets no response headers in time", async () => {
		const send = (request: Request) =>
			new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
		await expect(fetchWithFirstByteTimeout(new Request("https://api.aiand.com/v1/chat/completions", { method: "POST", body: "{}" }), 20, send)).rejects.toThrow("no response within");
	});
});
