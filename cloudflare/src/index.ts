import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getSandbox, Sandbox, type DirectoryBackup } from "@cloudflare/sandbox";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";
import { cachedSnapshot, planSessionRequest, readRpcResult, saveSnapshot, snapshotKey, snapshotResponse } from "./mcp-session";
import { AIAND_PLACEHOLDER, CREDENTIAL_HOSTS, FIRECRAWL_PLACEHOLDER, egressMode, type ModelBudgetResult } from "./egress";

// Outbound interception entrypoint: attaches API keys, enforces budgets and egress policy.
export { ContainerProxy } from "./egress";

const BRIDGE_PORT = 8080;
const BRIDGE_READY_TIMEOUT_MS = 120_000;
const SANDBOX_SLEEP_AFTER = "30m";
const SUPERVISOR_PROCESS_ID = "kimi-supervisor";
// A busy Kimi keeps the container awake, but never longer than this without client activity.
const MAX_UNATTENDED_BUSY_MS = 6 * 60 * 60 * 1000;

// Directories that survive container restarts via Sandbox backups in R2.
const PERSISTED_DIRS = ["/home/kimi", "/workspace"] as const;
const STATE_DIR = "/home/kimi";
const BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;
// Reinstallable dependencies and caches are not persisted (Kimi is told to reinstall them).
const BACKUP_EXCLUDES = [
	"node_modules",
	".venv",
	"__pycache__",
	"*.pyc",
	".cache",
	".pytest_cache",
	".mypy_cache",
	".next",
	"*.part-*",
];
// du excludes matching BACKUP_EXCLUDES, used to size a directory before backing it up.
const DU_EXCLUDES = BACKUP_EXCLUDES.map((pattern) => `--exclude='${pattern}'`).join(" ");
const DEFAULT_BACKUP_MAX_MB = 4096;

// Tool calls that create or change jobs. The job registry is backed up before
// kimi_delegate_task / kimi_continue_task acknowledgements reach the client.
const JOB_ACK_TOOLS = new Set(["kimi_delegate_task", "kimi_continue_task"]);
// Calls after which Kimi may have produced files: back up everything.
const JOB_CHANGE_TOOLS = new Set(["kimi_delegate_and_wait", "kimi_wait_until_idle", "kimi_get_handoff", "kimi_abort"]);

const SANDBOX_ID_PATTERN = /^user-[0-9a-f]{40}$/;
// Written into the container trust store by the sandbox runtime when HTTPS interception is on.
const INTERCEPT_CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const passThrough = (request: Request) => fetch(request);

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
	override interceptHttps = true;

	private readonly bridgeToken: string;
	private egressConfigured = false;
	private starting?: Promise<void>;
	private backingUp?: Promise<void>;
	private rerun?: Promise<void>;
	private rerunFull = false;

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.bridgeToken = env.BRIDGE_TOKEN;
		this.envVars = {
			// Placeholders only: the real keys are attached to outbound requests by the Worker.
			AIAND_API_KEY: AIAND_PLACEHOLDER,
			FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY && env.FIRECRAWL_API_KEY !== "disabled" ? FIRECRAWL_PLACEHOLDER : "disabled",
			KIMI_MCP_AUTH_TOKEN: env.BRIDGE_TOKEN,
			KIMI_ORGANIZATION_ID: env.ORGANIZATION_ID || "default",
			KIMI_CONNECTOR_INSTANCE_ID: "cloudflare",
			// Swarm guardrails: agents per task (users can lower/raise within the cap)
			// and how many workers call ai& at the same time.
			KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: env.SWARM_CONCURRENCY || "4",
			KIMI_MAX_AGENTS_CAP: env.MAX_AGENTS_CAP || "32",
			KIMI_DEFAULT_MAX_AGENTS: env.DEFAULT_MAX_AGENTS || "4",
		};
	}

	/** Make sure the bridge is serving; restores state and starts it on a fresh container. */
	async ensureRuntime(sandboxId: string, publicBaseUrl: string): Promise<void> {
		await this.ctx.storage.delete("busySince");
		await this.configureEgress();
		if (await this.bridgeHealthy()) return;
		this.starting ??= this.startRuntime(sandboxId, publicBaseUrl).finally(() => {
			this.starting = undefined;
		});
		await this.starting;
	}

	/**
	 * Snapshot persisted directories to R2. `stateOnly` limits it to the job
	 * registry and Kimi sessions. Concurrent requests coalesce into at most one
	 * follow-up run so bursts of activity do not queue many backups.
	 */
	async backupNow(stateOnly = false): Promise<void> {
		if (this.backingUp) {
			this.rerunFull ||= !stateOnly;
			this.rerun ??= this.backingUp.catch(() => {}).then(() => {
				const full = this.rerunFull;
				this.rerun = undefined;
				this.rerunFull = false;
				return this.backupNow(!full);
			});
			return this.rerun;
		}
		this.backingUp = this.runBackup(stateOnly ? [STATE_DIR] : [...PERSISTED_DIRS]).finally(() => {
			this.backingUp = undefined;
		});
		await this.backingUp;
	}

	/** Stop the container. The next request restores from the latest backup and starts fresh. */
	async restartRuntime(): Promise<void> {
		await this.stop();
	}

	async backupStatus(): Promise<{ lastBackupAt: number | null; backups: Record<string, string>; skipped: unknown }> {
		const backups: Record<string, string> = {};
		for (const dir of PERSISTED_DIRS) {
			const handle = await this.ctx.storage.get<DirectoryBackup>(`backup:${dir}`);
			if (handle) backups[dir] = handle.id;
		}
		return {
			lastBackupAt: (await this.ctx.storage.get<number>("lastBackupAt")) ?? null,
			backups,
			skipped: (await this.ctx.storage.get("backupSkipped")) ?? null,
		};
	}

	/**
	 * Count one ai& model request against today's per-user limit. Called by the
	 * outbound proxy; AIAND_DAILY_REQUEST_LIMIT of 0 (or unset) means unlimited.
	 */
	async consumeModelRequest(): Promise<ModelBudgetResult> {
		const limit = Math.max(0, Number.parseInt(this.env.AIAND_DAILY_REQUEST_LIMIT ?? "0", 10) || 0);
		const key = `modelRequests:${new Date().toISOString().slice(0, 10)}`;
		const used = (await this.ctx.storage.get<number>(key)) ?? 0;
		if (limit > 0 && used >= limit) return { allowed: false, used, limit };
		await this.ctx.storage.put(key, used + 1);
		return { allowed: true, used: used + 1, limit };
	}

	async usage(): Promise<{ date: string; modelRequests: number; dailyLimit: number }> {
		const date = new Date().toISOString().slice(0, 10);
		return {
			date,
			modelRequests: (await this.ctx.storage.get<number>(`modelRequests:${date}`)) ?? 0,
			dailyLimit: Math.max(0, Number.parseInt(this.env.AIAND_DAILY_REQUEST_LIMIT ?? "0", 10) || 0),
		};
	}

	/**
	 * Fixed operator self-test: confirms the container holds no real keys and
	 * that ai&, Firecrawl, and general outbound access work through the proxy.
	 * Makes one minimal ai& request (counted against the user's budget).
	 */
	async selfTest(sandboxId: string, publicBaseUrl: string): Promise<Record<string, { ok: boolean; detail: string }>> {
		await this.ensureRuntime(sandboxId, publicBaseUrl);
		const checks: Record<string, string> = {
			placeholderKeys: `real=$(for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $f 2>/dev/null; done | grep -E '^(AIAND_API_KEY|KIMI_MODEL_API_KEY|FIRECRAWL_API_KEY)=' | grep -v -E '=(${AIAND_PLACEHOLDER}|${FIRECRAWL_PLACEHOLDER}|disabled)$' | sed 's/=.*/=<real value>/' | sort -u); test -z "$real" && echo placeholders-only || echo $real`,
			aiand: `curl -s -m 60 -o /dev/null -w '%{http_code}' https://api.aiand.com/v1/chat/completions -H "authorization: Bearer $AIAND_API_KEY" -H 'content-type: application/json' -d '{"model":"moonshotai/kimi-k3","max_tokens":1,"messages":[{"role":"user","content":"ok"}]}'`,
			firecrawl: `test "$FIRECRAWL_API_KEY" = disabled && echo disabled || curl -s -m 60 -o /dev/null -w '%{http_code}' https://api.firecrawl.dev/v2/scrape -H "authorization: Bearer $FIRECRAWL_API_KEY" -H 'content-type: application/json' -d '{"url":"https://example.com","formats":["markdown"]}'`,
			https: `curl -s -m 30 -o /dev/null -w '%{http_code}' https://example.com`,
			git: `git ls-remote https://github.com/cloudflare/sandbox-sdk HEAD | cut -c1-12`,
			pip: `python3 -c "import urllib.request;print(urllib.request.urlopen('https://pypi.org/simple/six/',timeout=30).status)"`,
			npm: `npm view left-pad version`,
		};
		const expect: Record<string, (out: string) => boolean> = {
			placeholderKeys: (out) => out === "placeholders-only",
			aiand: (out) => out === "200",
			firecrawl: (out) => out === "200" || out === "disabled",
			https: (out) => out === "200",
			git: (out) => /^[0-9a-f]{12}$/.test(out),
			pip: (out) => out === "200",
			npm: (out) => /^\d+\.\d+\.\d+$/.test(out),
		};
		const results: Record<string, { ok: boolean; detail: string }> = {};
		for (const [name, command] of Object.entries(checks)) {
			try {
				const result = await this.exec(`bash -c '${command.replace(/'/g, "'\\''")}'`);
				const out = `${result.stdout}`.trim();
				results[name] = { ok: expect[name](out), detail: (out || `${result.stderr}`.trim()).slice(0, 300) };
			} catch (error) {
				results[name] = { ok: false, detail: String(error).slice(0, 300) };
			}
		}
		return results;
	}

	/** Start a backup without waiting for it (used after uploads and completed jobs). */
	async requestBackup(stateOnly = false): Promise<void> {
		void this.backupNow(stateOnly).catch((error) => console.error("background backup failed", error));
	}

	override async onActivityExpired(): Promise<void> {
		try {
			if (await this.kimiBusy()) {
				const busySince = (await this.ctx.storage.get<number>("busySince")) ?? Date.now();
				await this.ctx.storage.put("busySince", busySince);
				if (Date.now() - busySince < MAX_UNATTENDED_BUSY_MS) {
					this.renewActivityTimeout();
					return;
				}
				console.error("Kimi busy beyond the unattended limit; sleeping anyway");
			}
		} catch (error) {
			console.error("activity probe failed", error);
		}
		await this.ctx.storage.delete("busySince");

		try {
			await this.backupNow();
		} catch (error) {
			console.error("backup before sleep failed", error);
		}
		await super.onActivityExpired();
	}

	/** In log/allowlist mode every outbound request goes through the proxy, not just credential hosts. */
	private async configureEgress(): Promise<void> {
		if (this.egressConfigured) return;
		if (egressMode(this.env) !== "open") await this.setOutboundHandler("egress");
		this.egressConfigured = true;
	}

	private async directorySizeMb(dir: string): Promise<number | null> {
		try {
			const result = await this.exec(`du -sm ${DU_EXCLUDES} ${dir} 2>/dev/null | cut -f1`);
			const size = Number.parseInt(`${result.stdout}`.trim(), 10);
			return Number.isFinite(size) ? size : null;
		} catch {
			return null;
		}
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
					NODE_EXTRA_CA_CERTS: INTERCEPT_CA_PATH,
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
		const maxMb = Number.parseInt(this.env.BACKUP_MAX_MB ?? "", 10) || DEFAULT_BACKUP_MAX_MB;
		const skipped: string[] = [];
		for (const dir of dirs) {
			// The state directory is small and holds the job registry; always back it up.
			if (dir !== STATE_DIR) {
				const sizeMb = await this.directorySizeMb(dir);
				if (sizeMb !== null && sizeMb > maxMb) {
					console.error(`backup of ${dir} skipped: ${sizeMb} MB exceeds BACKUP_MAX_MB=${maxMb}`);
					skipped.push(`${dir} (${sizeMb} MB > ${maxMb} MB)`);
					continue;
				}
			}
			const handle = await this.createBackup({
				dir,
				name: `${dir.replace(/\//g, "_")}-${new Date().toISOString()}`,
				ttl: BACKUP_TTL_SECONDS,
				excludes: BACKUP_EXCLUDES,
				localBucket: true,
			});
			await this.ctx.storage.put(`backup:${dir}`, handle);
		}
		if (skipped.length) await this.ctx.storage.put("backupSkipped", { at: Date.now(), dirs: skipped });
		else if (dirs.length === PERSISTED_DIRS.length) await this.ctx.storage.delete("backupSkipped");
		await this.ctx.storage.put("lastBackupAt", Date.now());
	}
}

// Assigned (not declared as static fields) so the SDK's registering setters run.
// Intercept the credential hosts; the ContainerProxy in ./egress attaches the keys.
KimiSandbox.outboundByHost = Object.fromEntries(CREDENTIAL_HOSTS.map((host) => [host, passThrough]));
// Catch-all used when EGRESS_MODE is log or allowlist.
KimiSandbox.outboundHandlers = { egress: passThrough };

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

function forwardHeaders(request: Request, env: Env, clientName?: string): Headers {
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
const mcpHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!props?.login) {
			return new Response("Unauthorized", { status: 401 });
		}

		const body = request.method === "POST" ? await request.text() : undefined;
		const action = planSessionRequest(request.method, request.headers.get("mcp-session-id"), body);
		if (action.kind === "respond") return action.response;

		const sandboxId = await sandboxIdFor(props.login);
		const sandbox = getSandbox(env.KIMI_SANDBOX, sandboxId, { sleepAfter: SANDBOX_SLEEP_AFTER });
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
	const response = await sandbox.containerFetch(
		new Request(`http://container${url.pathname}`, {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		}),
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
async function handleAdminRoute(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/admin\/sandboxes\/([^/]+)(?:\/(backup|restart|selftest))?$/.exec(url.pathname);
	if (!match) return null;

	const supplied = new TextEncoder().encode(request.headers.get("authorization") ?? "");
	const expected = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
	if (!env.ADMIN_TOKEN || supplied.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(supplied, expected)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!SANDBOX_ID_PATTERN.test(match[1])) return Response.json({ error: "Unknown sandbox id" }, { status: 400 });

	const sandbox = getSandbox(env.KIMI_SANDBOX, match[1], { sleepAfter: SANDBOX_SLEEP_AFTER });
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

export default new OAuthProvider({
	apiHandler: mcpHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: {
		async fetch(request: Request, env: Env, ctx: ExecutionContext) {
			return (
				(await handleFileRoute(request, env)) ??
				(await handleAdminRoute(request, env)) ??
				handleAccessRequest(request, env as any, ctx)
			);
		},
	} as any,
	tokenEndpoint: "/token",
});
