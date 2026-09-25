import { vi } from "vitest";
import { fileGrantKey, hmacKey, type BackupStatus, type RouteDeps, type RouteEnv, type SandboxApi } from "../src/routes";
import type { SnapshotStore } from "../src/mcp-session";

export const BRIDGE_TOKEN = "bridge-token-for-tests";
export const ADMIN_TOKEN = "admin-token-for-tests";
export const SANDBOX_ID = `user-${"a".repeat(40)}`;

export class MemoryKv implements SnapshotStore {
	readonly data = new Map<string, string>();
	async get(key: string) {
		return this.data.get(key) ?? null;
	}
	async put(key: string, value: string) {
		this.data.set(key, value);
	}
}

export function makeEnv(overrides: Partial<RouteEnv> = {}): RouteEnv & { OAUTH_KV: MemoryKv } {
	return { BRIDGE_TOKEN, ADMIN_TOKEN, OAUTH_KV: new MemoryKv(), CF_VERSION_METADATA: { id: "v-test" }, ...overrides } as RouteEnv & {
		OAUTH_KV: MemoryKv;
	};
}

/** A fake sandbox whose container answers MCP requests with a canned JSON-RPC result. */
export function makeSandbox(containerResponse: (request: Request) => Response | Promise<Response> = defaultContainer) {
	const status: BackupStatus = { lastBackupAt: 1, backups: { "/workspace": "b1" }, skipped: null };
	const calls: string[] = [];
	const sandbox = {
		ensureRuntime: vi.fn(async () => {
			calls.push("ensureRuntime");
		}),
		containerFetch: vi.fn(async (request: Request) => {
			calls.push("containerFetch");
			return containerResponse(request);
		}),
		backupNow: vi.fn(async () => {
			calls.push("backupNow");
		}),
		requestBackup: vi.fn(async () => {
			calls.push("requestBackup");
		}),
		backupStatus: vi.fn(async () => status),
		usage: vi.fn(async () => ({ date: "2026-09-25", modelRequests: 5, dailyLimit: 3000 })),
		restartRuntime: vi.fn(async () => {}),
		selfTest: vi.fn(async () => ({ aiand: { ok: true, detail: "200" } })),
	} satisfies SandboxApi;
	const requested: string[] = [];
	const deps: RouteDeps = {
		sandbox: (_env, id) => {
			requested.push(id);
			return sandbox;
		},
	};
	return { sandbox, deps, calls, requested };
}

async function defaultContainer(request: Request): Promise<Response> {
	const body = (await request.json()) as { id: number; method: string };
	const result =
		body.method === "initialize"
			? { protocolVersion: "2025-06-18", serverInfo: { name: "kimi", version: "1" }, capabilities: { tools: {} } }
			: body.method === "tools/list"
				? { tools: [{ name: "kimi_bridge_status" }] }
				: { content: [{ type: "text", text: "ok" }] };
	// The bridge answers over SSE, like the real stateless transport.
	return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

export function executionContext(props?: Record<string, unknown>) {
	const pending: Promise<unknown>[] = [];
	return {
		ctx: { props, waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext,
		pending,
	};
}

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a file link token the way the bridge does (payload.signature, per-sandbox key). */
export async function signGrant(payload: Record<string, unknown>, sandboxId = SANDBOX_ID, bridgeToken = BRIDGE_TOKEN): Promise<string> {
	const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await hmacKey(await fileGrantKey(bridgeToken, sandboxId));
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
	return `${encoded}.${b64url(signature)}`;
}

/** JSON-RPC body; `id: null` makes it a notification. */
export function rpc(method: string, params: Record<string, unknown> = {}, id: number | null = 1) {
	return JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
}
