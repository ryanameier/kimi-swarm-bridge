/**
 * MCP session layer in the Worker.
 *
 * The Worker answers the handshake (initialize, notifications, ping) and
 * tools/list from a cached snapshot, so connecting or refreshing a connector
 * does not wake a sleeping container, and sessions survive container restarts.
 * Everything else goes to the container's stateless MCP endpoint. Snapshots
 * are captured from the container the first time they are needed after each
 * deploy (keyed by Worker version, protocol version and client name, since the
 * tool list differs per client).
 */

export const SESSION_PREFIX = "ks1";
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

export type SessionAction =
	| { kind: "respond"; response: Response }
	| { kind: "snapshot"; method: "initialize" | "tools/list"; message: JsonRpcMessage; clientName: string; protocolVersion: string; sessionId: string; newSession: boolean }
	| { kind: "forward"; clientName: string };

function b64url(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): string {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function sanitizeClientName(name: unknown): string {
	return typeof name === "string" ? name.replace(/[^\x20-\x7e]/g, "").slice(0, 64) : "";
}

/** Session ids carry the client name and negotiated protocol version, so no session storage is needed. */
export function createSessionId(clientName: string, protocolVersion: string): string {
	return [SESSION_PREFIX, crypto.randomUUID(), b64url(clientName), b64url(protocolVersion)].join(".");
}

export function parseSessionId(sessionId: string | null): { clientName: string; protocolVersion: string } | null {
	if (!sessionId) return null;
	const parts = sessionId.split(".");
	if (parts.length !== 4 || parts[0] !== SESSION_PREFIX) return null;
	try {
		return { clientName: fromB64url(parts[2]), protocolVersion: fromB64url(parts[3]) };
	} catch {
		return null;
	}
}

function rpcError(status: number, code: number, message: string, id: JsonRpcMessage["id"] = null): Response {
	return Response.json({ jsonrpc: "2.0", error: { code, message }, id }, { status });
}

/** Decide how to handle one MCP HTTP request without touching the container. */
export function planSessionRequest(method: string, sessionHeader: string | null, body: string | undefined): SessionAction {
	const session = parseSessionId(sessionHeader);

	if (method === "DELETE") return { kind: "respond", response: new Response(null, { status: 204 }) };
	if (method === "GET") {
		// No server-initiated stream; clients fall back to POST responses.
		return { kind: "respond", response: new Response(null, { status: 405, headers: { allow: "POST, DELETE" } }) };
	}
	if (method !== "POST") return { kind: "respond", response: new Response(null, { status: 405, headers: { allow: "POST, DELETE" } }) };

	let parsed: unknown;
	try {
		parsed = JSON.parse(body ?? "");
	} catch {
		return { kind: "respond", response: rpcError(400, -32700, "Parse error") };
	}

	const message = (Array.isArray(parsed) ? undefined : parsed) as JsonRpcMessage | undefined;

	if (message?.method === "initialize") {
		const clientInfo = message.params?.clientInfo as { name?: unknown } | undefined;
		const clientName = sanitizeClientName(clientInfo?.name);
		const protocolVersion = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "";
		return {
			kind: "snapshot",
			method: "initialize",
			message,
			clientName,
			protocolVersion,
			sessionId: createSessionId(clientName, protocolVersion),
			newSession: true,
		};
	}

	if (!sessionHeader) return { kind: "respond", response: rpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required") };
	// Unknown or pre-upgrade session ids: 404 tells the client to initialize again.
	if (!session) return { kind: "respond", response: rpcError(404, -32001, "Session not found") };

	if (message && message.id === undefined) return { kind: "respond", response: new Response(null, { status: 202 }) };
	if (message?.method === "ping") return { kind: "respond", response: Response.json({ jsonrpc: "2.0", id: message.id, result: {} }) };
	if (message?.method === "tools/list" && !message.params?.cursor) {
		return {
			kind: "snapshot",
			method: "tools/list",
			message,
			clientName: session.clientName,
			protocolVersion: session.protocolVersion,
			sessionId: sessionHeader,
			newSession: false,
		};
	}
	return { kind: "forward", clientName: session.clientName };
}

export function snapshotKey(version: string, action: Extract<SessionAction, { kind: "snapshot" }>): string {
	return `mcp-snapshot:${version}:${action.method}:${action.protocolVersion}:${action.clientName.toLowerCase()}`;
}

/** Extract the JSON-RPC result from a JSON or single-event SSE MCP response. */
export async function readRpcResult(response: Response): Promise<unknown> {
	const text = await response.text();
	const payload = (response.headers.get("content-type") ?? "").includes("text/event-stream")
		? text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("")
		: text;
	const parsed = JSON.parse(payload) as { result?: unknown; error?: unknown };
	if (parsed.error !== undefined || parsed.result === undefined) throw new Error(`MCP error: ${payload.slice(0, 200)}`);
	return parsed.result;
}

export function snapshotResponse(action: Extract<SessionAction, { kind: "snapshot" }>, result: unknown): Response {
	return Response.json(
		{ jsonrpc: "2.0", id: action.message.id ?? null, result },
		{ headers: { "mcp-session-id": action.sessionId } },
	);
}

export interface SnapshotStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export async function cachedSnapshot(store: SnapshotStore, key: string): Promise<unknown | undefined> {
	const value = await store.get(key);
	return value === null ? undefined : (JSON.parse(value) as unknown);
}

export async function saveSnapshot(store: SnapshotStore, key: string, result: unknown): Promise<void> {
	await store.put(key, JSON.stringify(result), { expirationTtl: SNAPSHOT_TTL_SECONDS });
}
