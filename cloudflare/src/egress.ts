/**
 * Outbound traffic from employee containers.
 *
 * Credentials: containers only hold placeholder API keys. Requests to the ai&
 * and Brave Search APIs are intercepted (HTTP and HTTPS; the container trusts the
 * Cloudflare interception CA) and the real key is attached here, so a prompt-
 * injected agent cannot read or exfiltrate it.
 *
 * Budget: each ai& model request is counted against the user's daily limit
 * (AIAND_DAILY_REQUEST_LIMIT, 0 = unlimited) in their sandbox Durable Object.
 *
 * Concurrency: model requests from every container pass through one AiandGate,
 * which keeps the organization under ai&'s in-flight limit (AIAND_CONCURRENCY_LIMIT).
 *
 * Timing: each model request, search and (in log/allowlist mode) page fetch is
 * logged with its duration, for finding where swarm time goes.
 *
 * Policy (EGRESS_MODE):
 *   open       only the credential hosts are intercepted; everything else goes direct (default)
 *   log        every outbound HTTP(S) request is logged (host, method, sandbox) and allowed
 *   allowlist  like log, but only hosts matching EGRESS_ALLOWLIST (comma-separated globs) are allowed
 */

export const AIAND_HOST = "api.aiand.com";
export const BRAVE_HOST = "api.search.brave.com";
export const CREDENTIAL_HOSTS = [AIAND_HOST, BRAVE_HOST] as const;

/** What containers see instead of real keys. */
export const AIAND_PLACEHOLDER = "aiand-key-held-by-worker";
export const BRAVE_PLACEHOLDER = "brave-key-held-by-worker";

export type EgressMode = "open" | "log" | "allowlist";

export interface ModelBudgetResult {
	allowed: boolean;
	used: number;
	limit: number;
}

/** The sandbox Durable Object method the proxy calls to count model requests. */
export interface ModelBudgetCounter {
	consumeModelRequest(): Promise<ModelBudgetResult>;
}

/** The AiandGate Durable Object methods the proxy calls. */
export interface ConcurrencyLimiter {
	acquire(): Promise<{ id: string; waitMs: number }>;
	release(id: string): Promise<void>;
}

export interface EgressEnv {
	AIAND_API_KEY: string;
	AIAND_GATE?: DurableObjectNamespace;
	BRAVE_API_KEY?: string;
	EGRESS_MODE?: string;
	EGRESS_ALLOWLIST?: string;
	KIMI_SANDBOX: DurableObjectNamespace;
}

export function egressMode(env: { EGRESS_MODE?: string }): EgressMode {
	const mode = (env.EGRESS_MODE ?? "").trim().toLowerCase();
	return mode === "log" || mode === "allowlist" ? mode : "open";
}

export function parseHostList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(/[\s,]+/)
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
}

/** `*` matches any run of characters; `*.example.com` also matches `example.com`. */
export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return patterns.some((pattern) => {
		if (pattern === host) return true;
		if (pattern.startsWith("*.") && host === pattern.slice(2)) return true;
		const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		return regex.test(host);
	});
}

/** Hosts that stay reachable in allowlist mode regardless of EGRESS_ALLOWLIST. */
export function effectiveAllowlist(env: { EGRESS_ALLOWLIST?: string }): string[] {
	return [...CREDENTIAL_HOSTS, ...parseHostList(env.EGRESS_ALLOWLIST)];
}

export function withCredential(request: Request, env: EgressEnv): Request | null {
	const host = new URL(request.url).hostname;
	const headers = new Headers(request.headers);
	if (host === AIAND_HOST && env.AIAND_API_KEY) {
		headers.set("authorization", `Bearer ${env.AIAND_API_KEY}`);
	} else if (host === BRAVE_HOST && env.BRAVE_API_KEY && env.BRAVE_API_KEY !== "disabled") {
		headers.set("x-subscription-token", env.BRAVE_API_KEY);
	} else {
		return null;
	}
	return new Request(request, { headers });
}

const SEARCH_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * Search requests are retried here on HTTP 429 (honouring Retry-After), so
 * workers do not spend model steps sleeping. Model requests are not retried:
 * Kimi already backs off on its own.
 */
async function fetchWithRetry(request: Request, retry: boolean, sleep: (ms: number) => Promise<void>): Promise<Response> {
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetch(retry ? request.clone() : request);
		if (!retry || response.status !== 429 || attempt >= SEARCH_RETRIES) return response;
		const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
		const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
		await sleep(Math.min(Math.max(wait, 100), MAX_RETRY_WAIT_MS));
	}
}

/** Model calls that count against the daily budget (not model listing etc.). */
export function isModelRequest(request: Request): boolean {
	const url = new URL(request.url);
	return url.hostname === AIAND_HOST && request.method === "POST" && /\/(chat\/)?completions$|\/responses$|\/messages$/.test(url.pathname);
}

function budgetExceeded(result: ModelBudgetResult): Response {
	// OpenAI-style error so Kimi reports it instead of retrying as a rate limit.
	return Response.json(
		{
			error: {
				message: `Daily ai& request limit reached (${result.used}/${result.limit}). It resets at 00:00 UTC; ask your Kimi Swarm admin to raise AIAND_DAILY_REQUEST_LIMIT.`,
				type: "insufficient_quota",
				code: "daily_request_limit",
			},
		},
		{ status: 402 },
	);
}

function logEgress(entry: Record<string, unknown>): void {
	console.log(JSON.stringify({ event: "egress", ...entry }));
}

export function gateFor(env: EgressEnv): ConcurrencyLimiter | undefined {
	return env.AIAND_GATE ? (env.AIAND_GATE.get(env.AIAND_GATE.idFromName("org")) as unknown as ConcurrencyLimiter) : undefined;
}

/** Calls `done` once the response body has been fully sent (or the stream fails). */
export function whenBodyDone(response: Response, done: () => void): Response {
	if (!response.body) {
		done();
		return response;
	}
	const { readable, writable } = new TransformStream();
	response.body.pipeTo(writable).catch(() => undefined).finally(done);
	return new Response(readable, response);
}

export interface ProxyProps {
	containerId?: string;
}

export async function handleEgress(
	request: Request,
	env: EgressEnv,
	props: ProxyProps,
	fallback: (request: Request) => Promise<Response>,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
	const url = new URL(request.url);
	const host = url.hostname.toLowerCase();
	const mode = egressMode(env);
	const sandbox = props.containerId ?? "";

	const credentialed = (CREDENTIAL_HOSTS as readonly string[]).includes(host) ? withCredential(request, env) : null;
	if (credentialed) {
		if (isModelRequest(request) && sandbox) {
			const stub = env.KIMI_SANDBOX.get(env.KIMI_SANDBOX.idFromString(sandbox)) as unknown as ModelBudgetCounter;
			const budget = await stub.consumeModelRequest();
			if (!budget.allowed) {
				logEgress({ sandbox, host, method: request.method, action: "budget-blocked", used: budget.used, limit: budget.limit });
				return budgetExceeded(budget);
			}
		}
		if (mode !== "open") logEgress({ sandbox, host, method: request.method, action: "credential" });
		const model = isModelRequest(request);
		const gate = model ? gateFor(env) : undefined;
		const lease = gate ? await gate.acquire() : undefined;
		const started = Date.now();
		const release = () => {
			if (lease) gate!.release(lease.id).catch((error) => console.error("aiand gate release failed", error));
		};
		let response: Response;
		try {
			response = await fetchWithRetry(credentialed, host === BRAVE_HOST, sleep);
		} catch (error) {
			release();
			throw error;
		}
		// Account-level problems (exhausted credits, revoked key) fail every task; make them visible to admins.
		if (response.status === 401 || response.status === 402 || response.status === 403) {
			console.error(JSON.stringify({ event: "egress-upstream-error", sandbox, host, status: response.status }));
		}
		const headersMs = Date.now() - started;
		if (!model) {
			console.log(JSON.stringify({ event: "timing", kind: host === BRAVE_HOST ? "search" : "aiand-other", sandbox, ms: headersMs, status: response.status }));
			return response;
		}
		const modelName = response.headers.get("x-model") ?? "";
		const inferenceMs = Number.parseInt(response.headers.get("x-inference-ms") ?? "", 10);
		return whenBodyDone(response, () => {
			release();
			console.log(JSON.stringify({
				event: "timing", kind: "model", sandbox, model: modelName, status: response.status,
				waitMs: lease?.waitMs ?? 0, headersMs, ms: Date.now() - started, inferenceMs: Number.isFinite(inferenceMs) ? inferenceMs : undefined,
			}));
		});
	}

	if (mode === "open") return fallback(request);

	if (mode === "allowlist" && !hostMatches(host, effectiveAllowlist(env))) {
		logEgress({ sandbox, host, method: request.method, action: "blocked" });
		return new Response(`Outbound access to ${host} is not allowed by this Kimi Swarm deployment.\n`, { status: 403 });
	}

	const started = Date.now();
	const response = await fallback(request);
	logEgress({ sandbox, host, method: request.method, action: "allowed", status: response.status, ms: Date.now() - started });
	return response;
}
