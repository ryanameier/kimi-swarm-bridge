import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getSandbox, Sandbox, type DirectoryBackup } from "@cloudflare/sandbox";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

// Required by the Sandbox SDK for outbound interception (bucket mounts etc.).
export { ContainerProxy } from "@cloudflare/sandbox";

const BRIDGE_PORT = 8080;
const BRIDGE_READY_TIMEOUT_MS = 120_000;
const SANDBOX_SLEEP_AFTER = "30m";
const SUPERVISOR_PROCESS_ID = "kimi-supervisor";

// Directories that survive container restarts via Sandbox backups in R2.
const PERSISTED_DIRS = ["/home/kimi", "/workspace"] as const;
const STATE_DIR = "/home/kimi";
const BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;
const BACKUP_EXCLUDES = ["node_modules/.cache", "*.part-*"];

// Tool calls that create or change jobs. The job registry is backed up before
// kimi_delegate_task / kimi_continue_task acknowledgements reach the client.
const JOB_ACK_TOOLS = new Set(["kimi_delegate_task", "kimi_continue_task"]);
const JOB_CHANGE_TOOLS = new Set(["kimi_delegate_and_wait", "kimi_abort"]);

const SANDBOX_ID_PATTERN = /^user-[0-9a-f]{40}$/;

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sandboxIdFor(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
	return `user-${hex(digest).slice(0, 40)}`;
}

async function hmacKey(secret: string | ArrayBuffer): Promise<CryptoKey> {
	const raw = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Per-sandbox key for signing file links; a container can only mint links for itself. */
async function fileGrantKey(bridgeToken: string, sandboxId: string): Promise<ArrayBuffer> {
	const master = await hmacKey(bridgeToken);
	return crypto.subtle.sign("HMAC", master, new TextEncoder().encode(`file-grant:${sandboxId}`));
}

/**
 * One sandbox container per authenticated employee. The Durable Object owns the
 * runtime lifecycle: restore persisted directories, start the supervisor (Kimi
 * Code + MCP bridge), keep the container awake while Kimi works, and back up
 * before it sleeps.
 */
export class KimiSandbox extends Sandbox<Env> {
	private readonly bridgeToken: string;
	private starting?: Promise<void>;
	private backingUp?: Promise<void>;

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.bridgeToken = env.BRIDGE_TOKEN;
		this.envVars = {
			AIAND_API_KEY: env.AIAND_API_KEY,
			FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY ?? "",
			KIMI_MCP_AUTH_TOKEN: env.BRIDGE_TOKEN,
			KIMI_ORGANIZATION_ID: env.ORGANIZATION_ID || "default",
			KIMI_CONNECTOR_INSTANCE_ID: "cloudflare",
		};
	}

	/** Make sure the bridge is serving; restores state and starts it on a fresh container. */
	async ensureRuntime(sandboxId: string, publicBaseUrl: string): Promise<void> {
		if (await this.bridgeHealthy()) return;
		this.starting ??= this.startRuntime(sandboxId, publicBaseUrl).finally(() => {
			this.starting = undefined;
		});
		await this.starting;
	}

	/** Snapshot persisted directories to R2. `stateOnly` limits it to the job registry and Kimi sessions. */
	async backupNow(stateOnly = false): Promise<void> {
		while (this.backingUp) await this.backingUp.catch(() => {});
		this.backingUp = this.runBackup(stateOnly ? [STATE_DIR] : [...PERSISTED_DIRS]).finally(() => {
			this.backingUp = undefined;
		});
		await this.backingUp;
	}

	override async onActivityExpired(): Promise<void> {
		try {
			if (await this.kimiBusy()) {
				this.renewActivityTimeout();
				return;
			}
		} catch (error) {
			console.error("activity probe failed", error);
		}

		try {
			await this.backupNow();
		} catch (error) {
			console.error("backup before sleep failed", error);
		}
		await super.onActivityExpired();
	}

	private async bridgeHealthy(): Promise<boolean> {
		try {
			const result = await this.exec(`curl -sf -m 3 http://127.0.0.1:${BRIDGE_PORT}/healthz`);
			return result.exitCode === 0;
		} catch {
			return false;
		}
	}

	private async kimiBusy(): Promise<boolean> {
		const result = await this.exec(
			`curl -sf -m 10 -H "authorization: Bearer $KIMI_MCP_AUTH_TOKEN" http://127.0.0.1:${BRIDGE_PORT}/activity`,
		);
		if (result.exitCode !== 0) return false;
		return (JSON.parse(result.stdout) as { busy?: boolean }).busy === true;
	}

	private async startRuntime(sandboxId: string, publicBaseUrl: string): Promise<void> {
		const existing = await this.getProcess(SUPERVISOR_PROCESS_ID).catch(() => null);

		if (!existing || existing.status !== "running") {
			for (const dir of PERSISTED_DIRS) {
				const handle = await this.ctx.storage.get<DirectoryBackup>(`backup:${dir}`);
				if (!handle) continue;
				try {
					await this.restoreBackup(handle);
				} catch (error) {
					console.error(`restore of ${dir} failed`, error);
				}
			}

			await this.exec(`mkdir -p ${STATE_DIR}/kimi-code ${STATE_DIR}/state ${STATE_DIR}/jobs`);
			await this.startProcess("node /app/supervisor.mjs", {
				processId: SUPERVISOR_PROCESS_ID,
				env: {
					KIMI_SANDBOX_ID: sandboxId,
					KIMI_FILE_GRANT_KEY: hex(await fileGrantKey(this.bridgeToken, sandboxId)),
					KIMI_PUBLIC_BASE_URL: publicBaseUrl,
				},
			});
		}

		const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await this.bridgeHealthy()) return;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		throw new Error("Kimi runtime did not become ready within 120 seconds");
	}

	private async runBackup(dirs: readonly string[]): Promise<void> {
		for (const dir of dirs) {
			const handle = await this.createBackup({
				dir,
				name: `${dir.replace(/\//g, "_")}-${new Date().toISOString()}`,
				ttl: BACKUP_TTL_SECONDS,
				excludes: BACKUP_EXCLUDES,
				localBucket: true,
			});
			await this.ctx.storage.put(`backup:${dir}`, handle);
		}
		await this.ctx.storage.put("lastBackupAt", Date.now());
	}
}

function jsonRpcError(status: number, message: string): Response {
	return Response.json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }, { status });
}

/** Names of tools invoked by a JSON-RPC request body (single or batch). */
function calledTools(body: string): string[] {
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

function forwardHeaders(request: Request, env: Env): Headers {
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${env.BRIDGE_TOKEN}`);
	headers.delete("cookie");
	return headers;
}

/**
 * Authenticated MCP traffic: route to the caller's own sandbox and replace the
 * client's OAuth token with the internal bridge credential.
 */
const mcpHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!props?.login) {
			return new Response("Unauthorized", { status: 401 });
		}

		const sandboxId = await sandboxIdFor(props.login);
		const sandbox = getSandbox(env.KIMI_SANDBOX, sandboxId, { sleepAfter: SANDBOX_SLEEP_AFTER });

		try {
			await sandbox.ensureRuntime(sandboxId, new URL(request.url).origin);
		} catch (error) {
			return jsonRpcError(503, `Kimi runtime unavailable: ${String(error)}`);
		}

		const body = request.method === "POST" ? await request.text() : undefined;
		const tools = body ? calledTools(body) : [];

		const response = await sandbox.containerFetch(
			new Request(`http://container/mcp`, { method: request.method, headers: forwardHeaders(request, env), body }),
			BRIDGE_PORT,
		);

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
			ctx.waitUntil(sandbox.backupNow(true).catch((error) => console.error("job registry backup failed", error)));
		}

		return response;
	},
} satisfies ExportedHandler<Env>;

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
async function handleFileRoute(request: Request, env: Env): Promise<Response | null> {
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

	const sandbox = getSandbox(env.KIMI_SANDBOX, payload.sid, { sleepAfter: SANDBOX_SLEEP_AFTER });
	try {
		await sandbox.ensureRuntime(payload.sid, url.origin);
	} catch (error) {
		return deny(503, `Kimi runtime unavailable: ${String(error)}`);
	}

	const headers = forwardHeaders(request, env);
	return sandbox.containerFetch(
		new Request(`http://container${url.pathname}`, {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		}),
		BRIDGE_PORT,
	);
}

export default new OAuthProvider({
	apiHandler: mcpHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: {
		async fetch(request: Request, env: Env, ctx: ExecutionContext) {
			return (await handleFileRoute(request, env)) ?? handleAccessRequest(request, env as any, ctx);
		},
	} as any,
	tokenEndpoint: "/token",
});
