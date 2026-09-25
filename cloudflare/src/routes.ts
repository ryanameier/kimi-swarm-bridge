import { cachedSnapshot, planSessionRequest, readRpcResult, saveSnapshot, snapshotKey, snapshotResponse, type SnapshotStore } from "./mcp-session";
import type { Props } from "./workers-oauth-utils";

/**
 * HTTP routes of the Worker: MCP (after OAuth), signed file links and admin
 * endpoints. The sandbox Durable Object is injected so the routes can be
 * tested without the Workers runtime.
 */

export const BRIDGE_PORT = 8080;

// Tool calls that create or change jobs. The job registry is backed up before
// kimi_delegate_task / kimi_continue_task acknowledgements reach the client.
const JOB_ACK_TOOLS = new Set(["kimi_delegate_task", "kimi_continue_task"]);
// Calls after which Kimi may have produced files: back up everything.
const JOB_CHANGE_TOOLS = new Set(["kimi_delegate_and_wait", "kimi_wait_until_idle", "kimi_get_handoff", "kimi_abort"]);

export const SANDBOX_ID_PATTERN = /^user-[0-9a-f]{40}$/;

export interface BackupStatus {
	lastBackupAt: number | null;
	backups: Record<string, string>;
	skipped: unknown;
}

/** The parts of the sandbox Durable Object the routes use. */
export interface SandboxApi {
	ensureRuntime(sandboxId: string, publicBaseUrl: string): Promise<void>;
	containerFetch(request: Request, port: number): Promise<Response>;
	backupNow(stateOnly?: boolean): Promise<void>;
	requestBackup(stateOnly?: boolean): Promise<void>;
	backupStatus(): Promise<BackupStatus>;
	usage(): Promise<{ date: string; modelRequests: number; dailyLimit: number }>;
	restartRuntime(): Promise<void>;
	selfTest(sandboxId: string, publicBaseUrl: string): Promise<Record<string, { ok: boolean; detail: string }>>;
}

export interface RouteEnv {
	BRIDGE_TOKEN: string;
	ADMIN_TOKEN?: string;
	OAUTH_KV: SnapshotStore;
	CF_VERSION_METADATA?: { id: string };
}

export interface RouteDeps<E extends RouteEnv = RouteEnv> {
	sandbox(env: E, sandboxId: string): SandboxApi;
}

export function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sandboxIdFor(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
	return `user-${hex(digest).slice(0, 40)}`;
}

export async function hmacKey(secret: string | ArrayBuffer): Promise<CryptoKey> {
	const raw = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Per-sandbox key for signing file links; a container can only mint links for itself. */
export async function fileGrantKey(bridgeToken: string, sandboxId: string): Promise<ArrayBuffer> {
	const master = await hmacKey(bridgeToken);
	return crypto.subtle.sign("HMAC", master, new TextEncoder().encode(`file-grant:${sandboxId}`));
}


export function jsonRpcError(status: number, message: string): Response {
	return Response.json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }, { status });
}

/** Names of tools invoked by a JSON-RPC request body (single or batch). */
export function calledTools(body: string): string[] {
	try {
		const parsed = JSON.parse(body) as unknown;
		const messages = Array.isArray(parsed) ? parsed : [parsed];
		return messages
			.filter((m): m is { method: string; params?: { name?: string } } => typeof m === "object" && m !== null && "method" in m)
			.filter((m) => m.method === "tools/call" && typeof m.params?.name === "string")
			.map((m) => m.params!.name!);
	} catch {
		return [];
	}
}

export function forwardHeaders(request: Request, env: RouteEnv, clientName?: string): Headers {
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${env.BRIDGE_TOKEN}`);
	headers.delete("cookie");
	if (clientName !== undefined) {
		// The Worker owns MCP sessions; the container serves each request statelessly.
		headers.delete("mcp-session-id");
		headers.set("x-kimi-mcp-mode", "stateless");
		headers.set("x-kimi-client-name", clientName);
	}
	return headers;
}

/**
 * Authenticated MCP traffic: route to the caller's own sandbox and replace the
 * client's OAuth token with the internal bridge credential.
 */
export function createMcpHandler<E extends RouteEnv>(deps: RouteDeps<E>) {
	return {
	async fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!props?.login) {
			return new Response("Unauthorized", { status: 401 });
		}

		const body = request.method === "POST" ? await request.text() : undefined;
		const action = planSessionRequest(request.method, request.headers.get("mcp-session-id"), body);
		if (action.kind === "respond") return action.response;

		const sandboxId = await sandboxIdFor(props.login);
		const sandbox = deps.sandbox(env, sandboxId);
		const toContainer = async (payload: string | undefined) => {
			await sandbox.ensureRuntime(sandboxId, new URL(request.url).origin);
			return sandbox.containerFetch(
				new Request(`http://container/mcp`, { method: "POST", headers: forwardHeaders(request, env, action.clientName), body: payload }),
				BRIDGE_PORT,
			);
		};

		// Handshake and tool list: answer from the snapshot without waking the container.
		if (action.kind === "snapshot") {
			const key = snapshotKey(env.CF_VERSION_METADATA?.id ?? "dev", action);
			let result = await cachedSnapshot(env.OAUTH_KV, key);
			if (result === undefined) {
				try {
					result = await readRpcResult(await toContainer(body));
				} catch (error) {
					return jsonRpcError(503, `Kimi runtime unavailable: ${String(error)}`);
				}
				await saveSnapshot(env.OAUTH_KV, key, result);
			}
			return snapshotResponse(action, result);
		}

		const tools = body ? calledTools(body) : [];
		let response: Response;
		try {
			response = await toContainer(body);
		} catch (error) {
			return jsonRpcError(503, `Kimi runtime unavailable: ${String(error)}`);
		}

		if (tools.some((name) => JOB_ACK_TOOLS.has(name)) && response.ok) {
			// Persist the job record before the client sees the acknowledgement.
			const text = await response.text();
			try {
				await sandbox.backupNow(true);
			} catch (error) {
				console.error("job registry backup failed", error);
			}
			return new Response(text, { status: response.status, headers: response.headers });
		}

		if (tools.some((name) => JOB_CHANGE_TOOLS.has(name))) {
			ctx.waitUntil(sandbox.requestBackup(false));
		}

		return response;
	},
	};
}

const FILE_CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, PUT, POST, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "600",
};

/**
 * Signed file links (`/files/upload/<token>`, `/files/download/<token>`). The
 * token is the authorization, so these routes sit outside OAuth. The signature
 * is checked here before any sandbox is woken; the bridge checks it again.
 */
export async function handleFileRoute<E extends RouteEnv>(request: Request, env: E, deps: RouteDeps<E>): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/files\/(upload|download)\/([A-Za-z0-9_\-]+)\.([A-Za-z0-9_\-]+)$/.exec(url.pathname);
	if (!match) return null;
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: FILE_CORS });

	const deny = (status: number, error: string) => Response.json({ error }, { status, headers: FILE_CORS });

	let payload: { sid?: unknown; exp?: unknown };
	try {
		payload = JSON.parse(atob(match[2].replace(/-/g, "+").replace(/_/g, "/")));
	} catch {
		return deny(400, "Malformed link");
	}
	if (typeof payload.sid !== "string" || !SANDBOX_ID_PATTERN.test(payload.sid)) return deny(400, "Malformed link");
	if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return deny(410, "Link expired");

	const key = await hmacKey(await fileGrantKey(env.BRIDGE_TOKEN, payload.sid));
	const signature = Uint8Array.from(atob(match[3].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
	const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(match[2]));
	if (!valid) return deny(403, "Invalid link signature");

	const sandbox = deps.sandbox(env, payload.sid);
	try {
		await sandbox.ensureRuntime(payload.sid, url.origin);
	} catch (error) {
		return deny(503, `Kimi runtime unavailable: ${String(error)}`);
	}

	const headers = forwardHeaders(request, env);
	const response = await sandbox.containerFetch(
		new Request(`http://container${url.pathname}`, {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
			// Streamed upload bodies (required by Node's fetch; accepted by Workers).
			duplex: "half",
		} as RequestInit),
		BRIDGE_PORT,
	);
	if (match[1] === "upload" && response.status === 201) {
		await sandbox.requestBackup(false);
	}
	return response;
}

/**
 * Operator endpoints, authenticated with the ADMIN_TOKEN secret:
 *   GET  /admin/sandboxes/<id>          backup status and today's ai& usage
 *   POST /admin/sandboxes/<id>/backup   back up now
 *   POST /admin/sandboxes/<id>/selftest fixed checks: no real keys in the container; ai&, Firecrawl, web, git, pip, npm reachable
 *   POST /admin/sandboxes/<id>/restart  stop the container (applies new images; next request restores)
 */
export async function handleAdminRoute<E extends RouteEnv>(request: Request, env: E, deps: RouteDeps<E>): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/admin\/sandboxes\/([^/]+)(?:\/(backup|restart|selftest))?$/.exec(url.pathname);
	if (!match) return null;

	const supplied = new TextEncoder().encode(request.headers.get("authorization") ?? "");
	const expected = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
	if (!env.ADMIN_TOKEN || supplied.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(supplied, expected)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!SANDBOX_ID_PATTERN.test(match[1])) return Response.json({ error: "Unknown sandbox id" }, { status: 400 });

	const sandbox = deps.sandbox(env, match[1]);
	if (!match[2] && request.method === "GET") {
		return Response.json({ ...(await sandbox.backupStatus()), usage: await sandbox.usage() });
	}
	if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });

	if (match[2] === "selftest") {
		const results = await sandbox.selfTest(match[1], url.origin);
		return Response.json({ ok: Object.values(results).every((r) => r.ok), results });
	}
	if (match[2] === "backup") {
		await sandbox.backupNow(false);
		return Response.json(await sandbox.backupStatus());
	}
	await sandbox.restartRuntime();
	return Response.json({ restarted: match[1] });
}
