import { describe, expect, it } from "vitest";
import { createMcpHandler, handleAdminRoute, handleFileRoute, sandboxIdFor } from "../src/routes";
import { ADMIN_TOKEN, BRIDGE_TOKEN, SANDBOX_ID, executionContext, makeEnv, makeSandbox, rpc, signGrant } from "./helpers";

const BASE = "https://kimi.example.workers.dev";

function mcpRequest(body: string | undefined, headers: Record<string, string> = {}, method = "POST") {
	return new Request(`${BASE}/mcp`, {
		method,
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
		body,
	});
}

async function initialize(handler: ReturnType<typeof createMcpHandler>, env: ReturnType<typeof makeEnv>, clientName = "claude-ai") {
	const { ctx } = executionContext({ login: "alice@example.com" });
	const response = await handler.fetch(
		mcpRequest(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } })),
		env,
		ctx,
	);
	return { response, sessionId: response.headers.get("mcp-session-id") ?? "" };
}

describe("MCP route", () => {
	it("rejects requests without an authenticated user", async () => {
		const { deps, calls } = makeSandbox();
		const { ctx } = executionContext(undefined);
		const response = await createMcpHandler(deps).fetch(mcpRequest(rpc("tools/list")), makeEnv(), ctx);
		expect(response.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it("routes each user to their own sandbox", async () => {
		const { deps, requested } = makeSandbox();
		const env = makeEnv();
		const handler = createMcpHandler(deps);
		const { sessionId } = await initialize(handler, env);
		for (const login of ["alice@example.com", "bob@example.com"]) {
			const { ctx } = executionContext({ login });
			await handler.fetch(mcpRequest(rpc("tools/call", { name: "kimi_bridge_status", arguments: {} }), { "mcp-session-id": sessionId }), env, ctx);
		}
		expect(requested.slice(-2)).toEqual([await sandboxIdFor("alice@example.com"), await sandboxIdFor("bob@example.com")]);
		expect(requested[requested.length - 1]).not.toBe(requested[requested.length - 2]);
	});

	it("answers initialize and tools/list from the snapshot without waking the container", async () => {
		const { deps, calls } = makeSandbox();
		const env = makeEnv();
		const handler = createMcpHandler(deps);

		// First handshake after a deploy captures the snapshot from the container.
		const first = await initialize(handler, env);
		expect(first.response.status).toBe(200);
		expect(first.sessionId).toMatch(/^ks1\./);
		expect(((await first.response.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("kimi");
		expect(calls).toEqual(["ensureRuntime", "containerFetch"]);

		// Later handshakes and tool lists do not touch the container.
		calls.length = 0;
		const second = await initialize(handler, env);
		const { ctx } = executionContext({ login: "alice@example.com" });
		const initialized = await handler.fetch(mcpRequest(rpc("notifications/initialized", {}, null), { "mcp-session-id": second.sessionId }), env, ctx);
		const ping = await handler.fetch(mcpRequest(rpc("ping"), { "mcp-session-id": second.sessionId }), env, ctx);
		expect(initialized.status).toBe(202);
		expect(((await ping.json()) as { result: unknown }).result).toEqual({});

		const list1 = await handler.fetch(mcpRequest(rpc("tools/list"), { "mcp-session-id": second.sessionId }), env, ctx);
		expect(((await list1.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
		expect(calls).toEqual(["ensureRuntime", "containerFetch"]); // tools/list captured once
		calls.length = 0;
		const list2 = await handler.fetch(mcpRequest(rpc("tools/list", {}, 9), { "mcp-session-id": second.sessionId }), env, ctx);
		expect(((await list2.json()) as { id: number }).id).toBe(9);
		expect(calls).toEqual([]);
	});

	it("keeps separate snapshots per client, since the tool list differs", async () => {
		const { deps } = makeSandbox();
		const env = makeEnv();
		const handler = createMcpHandler(deps);
		await initialize(handler, env, "claude-ai");
		await initialize(handler, env, "Other Client");
		expect([...env.OAUTH_KV.data.keys()].sort()).toEqual([
			"mcp-snapshot:v-test:initialize:2025-06-18:claude-ai",
			"mcp-snapshot:v-test:initialize:2025-06-18:other client",
		]);
	});

	it("forwards tool calls statelessly with the bridge credential and client name", async () => {
		let seen: Request | undefined;
		const { deps } = makeSandbox(async (request) => {
			seen = request;
			return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
		});
		const env = makeEnv();
		const handler = createMcpHandler(deps);
		const { sessionId } = await initialize(handler, env);
		const { ctx } = executionContext({ login: "alice@example.com" });
		await handler.fetch(
			mcpRequest(rpc("tools/call", { name: "kimi_bridge_status", arguments: {} }), {
				"mcp-session-id": sessionId,
				authorization: "Bearer client-oauth-token",
				cookie: "secret=1",
			}),
			env,
			ctx,
		);
		expect(seen?.headers.get("authorization")).toBe(`Bearer ${BRIDGE_TOKEN}`);
		expect(seen?.headers.get("cookie")).toBeNull();
		expect(seen?.headers.get("mcp-session-id")).toBeNull();
		expect(seen?.headers.get("x-kimi-mcp-mode")).toBe("stateless");
		expect(seen?.headers.get("x-kimi-client-name")).toBe("claude-ai");
	});

	it("asks clients with unknown or pre-upgrade sessions to initialize again", async () => {
		const { deps, calls } = makeSandbox();
		const { ctx } = executionContext({ login: "alice@example.com" });
		const handler = createMcpHandler(deps);
		const stale = await handler.fetch(mcpRequest(rpc("tools/list"), { "mcp-session-id": "3c08e26d-13a0-4606-b000-000000000000" }), makeEnv(), ctx);
		expect(stale.status).toBe(404);
		const missing = await handler.fetch(mcpRequest(rpc("tools/list")), makeEnv(), ctx);
		expect(missing.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("answers GET and DELETE without the container", async () => {
		const { deps, calls } = makeSandbox();
		const { ctx } = executionContext({ login: "alice@example.com" });
		const handler = createMcpHandler(deps);
		expect((await handler.fetch(mcpRequest(undefined, {}, "GET"), makeEnv(), ctx)).status).toBe(405);
		expect((await handler.fetch(mcpRequest(undefined, {}, "DELETE"), makeEnv(), ctx)).status).toBe(204);
		expect(calls).toEqual([]);
	});

	it("backs up the job registry before acknowledging a delegated task", async () => {
		const { deps, calls, sandbox } = makeSandbox();
		const env = makeEnv();
		const handler = createMcpHandler(deps);
		const { sessionId } = await initialize(handler, env);
		calls.length = 0;
		const { ctx } = executionContext({ login: "alice@example.com" });
		const response = await handler.fetch(
			mcpRequest(rpc("tools/call", { name: "kimi_delegate_task", arguments: {} }), { "mcp-session-id": sessionId }),
			env,
			ctx,
		);
		expect(calls).toEqual(["ensureRuntime", "containerFetch", "backupNow"]);
		expect(sandbox.backupNow).toHaveBeenCalledWith(true);
		expect(await response.text()).toContain('"ok"');
	});

	it("schedules a full backup after calls that may produce files", async () => {
		const { deps, sandbox } = makeSandbox();
		const env = makeEnv();
		const handler = createMcpHandler(deps);
		const { sessionId } = await initialize(handler, env);
		const { ctx, pending } = executionContext({ login: "alice@example.com" });
		await handler.fetch(mcpRequest(rpc("tools/call", { name: "kimi_get_handoff", arguments: {} }), { "mcp-session-id": sessionId }), env, ctx);
		await Promise.all(pending);
		expect(sandbox.requestBackup).toHaveBeenCalledWith(false);
		expect(sandbox.backupNow).not.toHaveBeenCalled();
	});

	it("reports an unavailable runtime as a JSON-RPC error", async () => {
		const { deps, sandbox } = makeSandbox();
		sandbox.ensureRuntime.mockRejectedValueOnce(new Error("boom"));
		const { response } = await initialize(createMcpHandler(deps), makeEnv());
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("Kimi runtime unavailable");
	});
});

describe("file links", () => {
	const future = () => Math.floor(Date.now() / 1000) + 600;

	it("forwards validly signed links to the owning sandbox and backs up after uploads", async () => {
		const { deps, calls, requested, sandbox } = makeSandbox(() => new Response("{}", { status: 201 }));
		const token = await signGrant({ v: 1, op: "up", sid: SANDBOX_ID, path: "inputs/a.txt", exp: future(), nonce: "n" });
		const response = await handleFileRoute(new Request(`${BASE}/files/upload/${token}`, { method: "PUT", body: "hello" }), makeEnv(), deps);
		expect(response?.status).toBe(201);
		expect(requested).toEqual([SANDBOX_ID]);
		expect(calls).toEqual(["ensureRuntime", "containerFetch", "requestBackup"]);
		const forwarded = sandbox.containerFetch.mock.calls[0][0] as Request;
		expect(forwarded.headers.get("authorization")).toBe(`Bearer ${BRIDGE_TOKEN}`);
		expect(new URL(forwarded.url).pathname).toBe(`/files/upload/${token}`);
	});

	it("rejects forged, cross-sandbox, expired and malformed links without waking a sandbox", async () => {
		const { deps, calls } = makeSandbox();
		const env = makeEnv();
		const other = `user-${"b".repeat(40)}`;
		const cases: Array<[string, number]> = [
			// Signed with a different bridge token.
			[await signGrant({ sid: SANDBOX_ID, exp: future() }, SANDBOX_ID, "wrong-token"), 403],
			// Signed for one sandbox, claiming another.
			[await signGrant({ sid: other, exp: future() }, SANDBOX_ID), 403],
			[await signGrant({ sid: SANDBOX_ID, exp: 1 }), 410],
			[await signGrant({ sid: "user-../../etc", exp: future() }), 400],
			["bm90LWpzb24.c2ln", 400],
		];
		for (const [token, status] of cases) {
			const response = await handleFileRoute(new Request(`${BASE}/files/download/${token}`), env, deps);
			expect(response?.status, token).toBe(status);
		}
		expect(calls).toEqual([]);
	});

	it("answers CORS preflight and ignores other paths", async () => {
		const { deps } = makeSandbox();
		const token = await signGrant({ sid: SANDBOX_ID, exp: future() });
		const preflight = await handleFileRoute(new Request(`${BASE}/files/upload/${token}`, { method: "OPTIONS" }), makeEnv(), deps);
		expect(preflight?.status).toBe(204);
		expect(preflight?.headers.get("access-control-allow-origin")).toBe("*");
		expect(await handleFileRoute(new Request(`${BASE}/authorize`), makeEnv(), deps)).toBeNull();
	});
});

describe("admin routes", () => {
	const admin = (path: string, method = "GET", token: string | null = ADMIN_TOKEN) =>
		new Request(`${BASE}/admin/sandboxes/${path}`, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } });

	it("requires the admin token", async () => {
		const { deps, requested } = makeSandbox();
		for (const token of [null, "wrong", `${ADMIN_TOKEN}x`]) {
			expect((await handleAdminRoute(admin(SANDBOX_ID, "GET", token), makeEnv(), deps))?.status).toBe(401);
		}
		expect((await handleAdminRoute(admin(SANDBOX_ID), makeEnv({ ADMIN_TOKEN: "" }), deps))?.status).toBe(401);
		expect(requested).toEqual([]);
	});

	it("validates sandbox ids and methods", async () => {
		const { deps } = makeSandbox();
		expect((await handleAdminRoute(admin("not-a-sandbox"), makeEnv(), deps))?.status).toBe(400);
		expect((await handleAdminRoute(admin(`${SANDBOX_ID}/restart`, "GET"), makeEnv(), deps))?.status).toBe(405);
		expect(await handleAdminRoute(new Request(`${BASE}/admin/other`), makeEnv(), deps)).toBeNull();
	});

	it("reports status and usage, backs up, restarts and self-tests", async () => {
		const { deps, sandbox } = makeSandbox();
		const env = makeEnv();
		const status = (await (await handleAdminRoute(admin(SANDBOX_ID), env, deps))!.json()) as { usage: { modelRequests: number } };
		expect(status.usage.modelRequests).toBe(5);

		await handleAdminRoute(admin(`${SANDBOX_ID}/backup`, "POST"), env, deps);
		expect(sandbox.backupNow).toHaveBeenCalledWith(false);

		await handleAdminRoute(admin(`${SANDBOX_ID}/restart`, "POST"), env, deps);
		expect(sandbox.restartRuntime).toHaveBeenCalled();

		const selftest = (await (await handleAdminRoute(admin(`${SANDBOX_ID}/selftest`, "POST"), env, deps))!.json()) as { ok: boolean };
		expect(selftest.ok).toBe(true);
		expect(sandbox.selfTest).toHaveBeenCalledWith(SANDBOX_ID, BASE);
	});
});
