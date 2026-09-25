import { ContainerProxy as SandboxContainerProxy } from "@cloudflare/sandbox";

/**
 * Outbound traffic from employee containers.
 *
 * Credentials: containers only hold placeholder API keys. Requests to the ai&
 * and Firecrawl APIs are intercepted (HTTP and HTTPS; the container trusts the
 * Cloudflare interception CA) and the real key is attached here, so a prompt-
 * injected agent cannot read or exfiltrate it.
 *
 * Budget: each ai& model request is counted against the user's daily limit
 * (AIAND_DAILY_REQUEST_LIMIT, 0 = unlimited) in their sandbox Durable Object.
 *
 * Policy (EGRESS_MODE):
 *   open       only the credential hosts are intercepted; everything else goes direct (default)
 *   log        every outbound HTTP(S) request is logged (host, method, sandbox) and allowed
 *   allowlist  like log, but only hosts matching EGRESS_ALLOWLIST (comma-separated globs) are allowed
 */

export const AIAND_HOST = "api.aiand.com";
export const FIRECRAWL_HOST = "api.firecrawl.dev";
export const CREDENTIAL_HOSTS = [AIAND_HOST, FIRECRAWL_HOST] as const;

/** What containers see instead of real keys. */
export const AIAND_PLACEHOLDER = "aiand-key-held-by-worker";
export const FIRECRAWL_PLACEHOLDER = "fc-key-held-by-worker";

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

export interface EgressEnv {
	AIAND_API_KEY: string;
	FIRECRAWL_API_KEY?: string;
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
	const key = host === AIAND_HOST ? env.AIAND_API_KEY : host === FIRECRAWL_HOST ? env.FIRECRAWL_API_KEY : undefined;
	if (!key || key === "disabled") return null;
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${key}`);
	return new Request(request, { headers });
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

interface ProxyProps {
	containerId?: string;
}

export async function handleEgress(
	request: Request,
	env: EgressEnv,
	props: ProxyProps,
	fallback: (request: Request) => Promise<Response>,
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
		return fetch(credentialed);
	}

	if (mode === "open") return fallback(request);

	if (mode === "allowlist" && !hostMatches(host, effectiveAllowlist(env))) {
		logEgress({ sandbox, host, method: request.method, action: "blocked" });
		return new Response(`Outbound access to ${host} is not allowed by this Kimi Swarm deployment.\n`, { status: 403 });
	}

	logEgress({ sandbox, host, method: request.method, action: "allowed" });
	return fallback(request);
}

/**
 * Worker entrypoint the container runtime sends intercepted traffic to. It
 * extends the Sandbox SDK proxy, which still handles SDK-internal hosts.
 */
export class ContainerProxy extends SandboxContainerProxy {
	override async fetch(request: Request): Promise<Response> {
		const props = ((this as unknown as { ctx: { props?: ProxyProps } }).ctx.props ?? {}) as ProxyProps;
		const host = new URL(request.url).hostname;
		if (host.endsWith(".internal") || host.endsWith(".sandbox.test")) return super.fetch(request);
		return handleEgress(request, this.env as unknown as EgressEnv, props, (req) => fetch(req));
	}
}
