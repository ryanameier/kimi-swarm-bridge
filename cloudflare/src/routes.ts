import { cachedSnapshot, planSessionRequest, readRpcResult, saveSnapshot, snapshotKey, snapshotResponse, type SnapshotStore } from "./mcp-session";
import type { Props } from "./workers-oauth-utils";
import { deleteBackup, listBackups, type BackupBucket } from "./backups";

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
	/** Starts the runtime if needed; returns this user's agent-cap override, if an admin set one. */
	ensureRuntime(sandboxId: string, publicBaseUrl: string): Promise<AgentLimits | void>;
	setAgentLimits(limits: AgentLimits | null): Promise<AgentLimits | null>;
	containerFetch(request: Request, port: number): Promise<Response>;
	backupNow(stateOnly?: boolean): Promise<void>;
	requestBackup(stateOnly?: boolean): Promise<void>;
	backupStatus(): Promise<BackupStatus>;
	usage(): Promise<{ date: string; modelRequests: number; dailyLimit: number }>;
	restartRuntime(): Promise<void>;
	selfTest(sandboxId: string, publicBaseUrl: string): Promise<Record<string, { ok: boolean; detail: string }>>;
	offboard(sandboxId: string): Promise<{ deletedBackups: string[] }>;
}

/** Per-user agent limits set by an admin; they override the deployment defaults. */
export interface AgentLimits {
	maxAgentsCap?: number;
	defaultMaxAgents?: number;
}

export interface RouteEnv {
	BRIDGE_TOKEN: string;
	MAX_AGENTS_CAP?: string;
	DEFAULT_MAX_AGENTS?: string;
	ADMIN_TOKEN?: string;
	OAUTH_KV: SnapshotStore & GrantKv;
	CF_VERSION_METADATA?: { id: string };
	BACKUP_BUCKET?: BackupBucket;
	/** Injected by the OAuth provider into non-API handlers. */
	OAUTH_PROVIDER?: GrantAdmin;
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

export function forwardHeaders(request: Request, env: RouteEnv, clientName?: string, limits?: AgentLimits | void): Headers {
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${env.BRIDGE_TOKEN}`);
	headers.delete("cookie");
	if (clientName !== undefined) {
		// The Worker owns MCP sessions; the container serves each request statelessly.
		headers.delete("mcp-session-id");
		headers.set("x-kimi-mcp-mode", "stateless");
		headers.set("x-kimi-client-name", clientName);
		// Agent limits travel with each request so changes apply without restarting containers.
		const cap = limits?.maxAgentsCap ?? Number.parseInt(env.MAX_AGENTS_CAP ?? "", 10);
		const initial = limits?.defaultMaxAgents ?? Number.parseInt(env.DEFAULT_MAX_AGENTS ?? "", 10);
		if (Number.isInteger(cap) && cap > 0) headers.set("x-kimi-max-agents-cap", String(cap));
		if (Number.isInteger(initial) && initial > 0) headers.set("x-kimi-default-max-agents", String(initial));
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
			const limits = await sandbox.ensureRuntime(sandboxId, new URL(request.url).origin);
			return sandbox.containerFetch(
				new Request(`http://container/mcp`, { method: "POST", headers: forwardHeaders(request, env, action.clientName, limits), body: payload }),
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

/** OAuth grant bookkeeping, used to list and offboard employees. */
interface GrantKv {
	list(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export interface GrantAdmin {
	listUserGrants(userId: string): Promise<{ items: { id: string; createdAt?: number; metadata?: { label?: string } }[] }>;
	revokeGrant(grantId: string, userId: string): Promise<void>;
}

/** Signed-in users (Access subjects) with grants, keyed by their sandbox id. */
export async function grantUsersBySandbox(kv: GrantKv): Promise<Map<string, { userId: string; grantIds: string[] }>> {
	const users = new Map<string, { userId: string; grantIds: string[] }>();
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: "grant:", cursor });
		for (const { name } of page.keys) {
			const rest = name.slice("grant:".length);
			const split = rest.lastIndexOf(":");
			if (split <= 0) continue;
			const userId = rest.slice(0, split);
			const sandboxId = await sandboxIdFor(userId);
			const entry = users.get(sandboxId) ?? { userId, grantIds: [] };
			entry.grantIds.push(rest.slice(split + 1));
			users.set(sandboxId, entry);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return users;
}

function adminAuthorized(request: Request, env: RouteEnv): boolean {
	const supplied = new TextEncoder().encode(request.headers.get("authorization") ?? "");
	const expected = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
	return !!env.ADMIN_TOKEN && supplied.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(supplied, expected);
}

/**
 * Operator endpoints, authenticated with the ADMIN_TOKEN secret:
 *   GET    /admin/sandboxes                 signed-in employees (sandbox id, name, grants)
 *   GET    /admin/sandboxes/<id>            backup status and today's ai& usage
 *   POST   /admin/sandboxes/<id>/backup     back up now
 *   POST   /admin/sandboxes/<id>/selftest   fixed checks: no real keys in the container; ai&, Brave search, browser rendering, web, git, pip, npm
 *   POST   /admin/sandboxes/<id>/restart    stop the container (applies new images; next request restores)
 *   POST   /admin/sandboxes/<id>/limits     per-user agent cap override {"maxAgentsCap": n, "defaultMaxAgents": n}, or null to clear; applies without restart
 *   DELETE /admin/sandboxes/<id>            offboard: revoke sign-ins, destroy the container, delete its state and backups
 *   GET    /admin/backups                   all backups in R2 with owner, size and date
 *   DELETE /admin/backups/<backup-id>       delete one backup
 */
export async function handleAdminRoute<E extends RouteEnv>(request: Request, env: E, deps: RouteDeps<E>): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/admin\/(sandboxes|backups)(?:\/([^/]+)(?:\/(backup|restart|selftest|limits))?)?$/.exec(url.pathname);
	if (!match) return null;
	if (!adminAuthorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const [, collection, id, action] = match;
	const methodNotAllowed = () => Response.json({ error: "Method not allowed" }, { status: 405 });

	if (collection === "backups") {
		if (!env.BACKUP_BUCKET) return Response.json({ error: "No backup bucket bound" }, { status: 501 });
		if (action) return null;
		if (!id) return request.method === "GET" ? Response.json({ backups: await listBackups(env.BACKUP_BUCKET) }) : methodNotAllowed();
		if (request.method !== "DELETE") return methodNotAllowed();
		if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Invalid backup id" }, { status: 400 });
		return Response.json({ deleted: id, objects: await deleteBackup(env.BACKUP_BUCKET, id) });
	}

	if (!id) {
		if (request.method !== "GET") return methodNotAllowed();
		const users = await grantUsersBySandbox(env.OAUTH_KV);
		const sandboxes = [];
		for (const [sandboxId, { userId, grantIds }] of users) {
			const grants = env.OAUTH_PROVIDER ? (await env.OAUTH_PROVIDER.listUserGrants(userId)).items : [];
			sandboxes.push({ sandboxId, name: grants[0]?.metadata?.label ?? null, grants: grantIds.length });
		}
		return Response.json({ sandboxes });
	}

	if (!SANDBOX_ID_PATTERN.test(id)) return Response.json({ error: "Unknown sandbox id" }, { status: 400 });
	const sandbox = deps.sandbox(env, id);

	if (!action && request.method === "GET") {
		return Response.json({ ...(await sandbox.backupStatus()), usage: await sandbox.usage() });
	}
	if (!action && request.method === "DELETE") {
		let revokedGrants = 0;
		const owner = (await grantUsersBySandbox(env.OAUTH_KV)).get(id);
		if (owner && env.OAUTH_PROVIDER) {
			for (const grantId of owner.grantIds) {
				await env.OAUTH_PROVIDER.revokeGrant(grantId, owner.userId);
				revokedGrants += 1;
			}
		}
		const { deletedBackups } = await sandbox.offboard(id);
		return Response.json({ offboarded: id, revokedGrants, deletedBackups });
	}
	if (request.method !== "POST" || !action) return methodNotAllowed();

	if (action === "limits") {
		let body: { maxAgentsCap?: unknown; defaultMaxAgents?: unknown } | null;
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: 'Send JSON: {"maxAgentsCap": 12, "defaultMaxAgents": 4}, or null to clear' }, { status: 400 });
		}
		if (body === null) return Response.json({ limits: await sandbox.setAgentLimits(null) });
		const positive = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 128 ? value : undefined);
		const limits: AgentLimits = {};
		if (body.maxAgentsCap !== undefined) limits.maxAgentsCap = positive(body.maxAgentsCap);
		if (body.defaultMaxAgents !== undefined) limits.defaultMaxAgents = positive(body.defaultMaxAgents);
		if (Object.values(limits).some((value) => value === undefined) || Object.keys(limits).length === 0) {
			return Response.json({ error: "maxAgentsCap and defaultMaxAgents must be whole numbers from 1 to 128" }, { status: 400 });
		}
		return Response.json({ limits: await sandbox.setAgentLimits(limits), note: "Applies to this user's next request; no restart needed." });
	}
	if (action === "selftest") {
		const results = await sandbox.selfTest(id, url.origin);
		return Response.json({ ok: Object.values(results).every((r) => r.ok), results });
	}
	if (action === "backup") {
		await sandbox.backupNow(false);
		return Response.json(await sandbox.backupStatus());
	}
	await sandbox.restartRuntime();
	return Response.json({ restarted: id });
}
