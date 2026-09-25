import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getSandbox, Sandbox, type DirectoryBackup } from "@cloudflare/sandbox";
import { handleAccessRequest } from "./access-handler";
import { BRIDGE_PORT, createMcpHandler, fileGrantKey, handleAdminRoute, handleFileRoute, hex, type RouteDeps } from "./routes";
import { backupName, deleteBackup, listBackups } from "./backups";
import { AIAND_PLACEHOLDER, CREDENTIAL_HOSTS, FIRECRAWL_PLACEHOLDER, egressMode, type ModelBudgetResult } from "./egress";

// Outbound interception entrypoint: attaches API keys, enforces budgets and egress policy.
export { ContainerProxy } from "./container-proxy";

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


// Written into the container trust store by the sandbox runtime when HTTPS interception is on.
const INTERCEPT_CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const passThrough = (request: Request) => fetch(request);

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
	private knownSandboxId?: string;
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
		if (this.knownSandboxId !== sandboxId) {
			await this.ctx.storage.put("sandboxId", sandboxId);
			this.knownSandboxId = sandboxId;
		}
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
			// Which bridge build this container runs (after a deploy, confirms the new image).
			build: `date -u -r /app/dist/index.js +%Y-%m-%dT%H:%M:%SZ`,
		};
		const expect: Record<string, (out: string) => boolean> = {
			placeholderKeys: (out) => out === "placeholders-only",
			aiand: (out) => out === "200",
			firecrawl: (out) => out === "200" || out === "disabled",
			https: (out) => out === "200",
			git: (out) => /^[0-9a-f]{12}$/.test(out),
			pip: (out) => out === "200",
			npm: (out) => /^\d+\.\d+\.\d+$/.test(out),
			build: (out) => /^\d{4}-/.test(out),
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

	/**
	 * Remove this employee's workspace: destroy the container and delete its
	 * backups and Durable Object state. The next sign-in starts from scratch.
	 */
	async offboard(sandboxId: string): Promise<{ deletedBackups: string[] }> {
		try {
			await this.destroy();
		} catch (error) {
			console.error("destroy during offboard failed", error);
		}
		const ids = new Set<string>();
		for (const dir of PERSISTED_DIRS) {
			for (const key of [`backup:${dir}`, `backup:${dir}:previous`]) {
				const handle = await this.ctx.storage.get<DirectoryBackup>(key);
				if (handle) ids.add(handle.id);
			}
		}
		for (const backup of await listBackups(this.env.BACKUP_BUCKET)) {
			if (backup.sandboxId === sandboxId) ids.add(backup.id);
		}
		for (const id of ids) await deleteBackup(this.env.BACKUP_BUCKET, id);
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.knownSandboxId = undefined;
		return { deletedBackups: [...ids] };
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
			const sandboxId = (await this.ctx.storage.get<string>("sandboxId")) ?? "user-unknown";
			const handle = await this.createBackup({
				dir,
				name: backupName(sandboxId, dir),
				ttl: BACKUP_TTL_SECONDS,
				excludes: BACKUP_EXCLUDES,
				localBucket: true,
			});
			// Keep the newest two backups per directory; delete older ones.
			const previous = await this.ctx.storage.get<DirectoryBackup>(`backup:${dir}`);
			const superseded = await this.ctx.storage.get<DirectoryBackup>(`backup:${dir}:previous`);
			await this.ctx.storage.put(`backup:${dir}`, handle);
			if (previous) await this.ctx.storage.put(`backup:${dir}:previous`, previous);
			if (superseded && superseded.id !== previous?.id) {
				await deleteBackup(this.env.BACKUP_BUCKET, superseded.id).catch((error) => console.error("pruning old backup failed", error));
			}
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

const deps: RouteDeps<Env> = {
	sandbox: (env, sandboxId) => getSandbox(env.KIMI_SANDBOX, sandboxId, { sleepAfter: SANDBOX_SLEEP_AFTER }),
};

export default new OAuthProvider({
	apiHandler: createMcpHandler(deps) as any,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: {
		async fetch(request: Request, env: Env, ctx: ExecutionContext) {
			return (
				(await handleFileRoute(request, env, deps)) ??
				(await handleAdminRoute(request, env, deps)) ??
				handleAccessRequest(request, env as any, ctx)
			);
		},
	} as any,
	tokenEndpoint: "/token",
});
