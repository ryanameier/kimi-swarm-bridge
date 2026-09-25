import { describe, expect, it } from "vitest";
import { createSessionId, parseSessionId, planSessionRequest, readRpcResult, sanitizeClientName } from "../src/mcp-session";

describe("session ids", () => {
	it("round-trip the client name and protocol version", () => {
		const id = createSessionId("Claude Desktop ✓", "2025-06-18");
		expect(id).toMatch(/^ks1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(parseSessionId(id)).toEqual({ clientName: "Claude Desktop ✓", protocolVersion: "2025-06-18" });
		expect(createSessionId("a", "b")).not.toBe(createSessionId("a", "b"));
	});

	it("reject foreign ids", () => {
		expect(parseSessionId(null)).toBeNull();
		expect(parseSessionId("3c08e26d-13a0-4606-b000-000000000000")).toBeNull();
		expect(parseSessionId("ks1.x.%%%.y")).toBeNull();
	});

	it("sanitizes client names", () => {
		expect(sanitizeClientName("claude-ai\n\u0000")).toBe("claude-ai");
		expect(sanitizeClientName(42)).toBe("");
		expect(sanitizeClientName("x".repeat(100))).toHaveLength(64);
	});
});

describe("planSessionRequest", () => {
	const session = createSessionId("claude-ai", "2025-06-18");
	const body = (message: object) => JSON.stringify({ jsonrpc: "2.0", ...message });

	it("plans initialize as a snapshot with a new session", () => {
		const plan = planSessionRequest("POST", null, body({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai" } } }));
		expect(plan).toMatchObject({ kind: "snapshot", method: "initialize", clientName: "claude-ai", protocolVersion: "2025-06-18", newSession: true });
	});

	it("serves the first tools/list page from the snapshot and forwards paginated ones", () => {
		expect(planSessionRequest("POST", session, body({ id: 2, method: "tools/list" }))).toMatchObject({ kind: "snapshot", method: "tools/list", clientName: "claude-ai" });
		expect(planSessionRequest("POST", session, body({ id: 2, method: "tools/list", params: { cursor: "2" } }))).toEqual({ kind: "forward", clientName: "claude-ai" });
	});

	it("forwards batches and other requests", () => {
		expect(planSessionRequest("POST", session, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call" }]))).toEqual({ kind: "forward", clientName: "claude-ai" });
		expect(planSessionRequest("POST", session, body({ id: 3, method: "resources/read" }))).toEqual({ kind: "forward", clientName: "claude-ai" });
	});

	it("rejects bad JSON", async () => {
		const plan = planSessionRequest("POST", session, "{");
		expect(plan.kind === "respond" && plan.response.status).toBe(400);
	});
});

describe("readRpcResult", () => {
	it("reads JSON and SSE responses", async () => {
		expect(await readRpcResult(Response.json({ jsonrpc: "2.0", id: 1, result: { a: 1 } }))).toEqual({ a: 1 });
		const sse = new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"b":2}}\n\n', { headers: { "content-type": "text/event-stream" } });
		expect(await readRpcResult(sse)).toEqual({ b: 2 });
	});

	it("refuses to cache errors", async () => {
		await expect(readRpcResult(Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }))).rejects.toThrow("MCP error");
	});
});
