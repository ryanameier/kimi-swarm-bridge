import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

// Required by the Sandbox SDK for outbound interception (bucket mounts etc.).
export { ContainerProxy } from "@cloudflare/sandbox";

const BRIDGE_PORT = 8080;
const BRIDGE_READY_TIMEOUT_MS = 120_000;
const SANDBOX_SLEEP_AFTER = "30m";

/**
 * One sandbox container per authenticated employee. The container runs the
 * existing supervisor (Kimi Code + MCP bridge); secrets are injected at start.
 */
export class KimiSandbox extends Sandbox<Env> {
	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.envVars = {
			AIAND_API_KEY: env.AIAND_API_KEY,
			FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY ?? "",
			KIMI_MCP_AUTH_TOKEN: env.BRIDGE_TOKEN,
		};
	}
}

async function sandboxIdFor(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `user-${hex.slice(0, 40)}`;
}

async function waitForBridge(sandbox: KimiSandbox): Promise<void> {
	const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			const res = await sandbox.containerFetch("http://container/healthz", { method: "GET" }, BRIDGE_PORT);
			if (res.ok) return;
			lastError = new Error(`bridge healthz returned ${res.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}

	throw new Error(`Kimi runtime did not become ready: ${String(lastError)}`);
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

		const sandbox = getSandbox(env.KIMI_SANDBOX, await sandboxIdFor(props.login), {
			sleepAfter: SANDBOX_SLEEP_AFTER,
		});

		try {
			await waitForBridge(sandbox);
		} catch (error) {
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32603, message: String(error) }, id: null },
				{ status: 503 },
			);
		}

		const headers = new Headers(request.headers);
		headers.set("authorization", `Bearer ${env.BRIDGE_TOKEN}`);
		headers.delete("cookie");

		const upstream = new Request("http://container/mcp", {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		});

		return sandbox.containerFetch(upstream, BRIDGE_PORT);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider({
	apiHandler: mcpHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
});
