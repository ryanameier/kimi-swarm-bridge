import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import process from 'node:process';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadBridgeConfig } from './config.js';
import { handleFileRequest, loadFileTransferConfig } from './file-transfer.js';
import { createMcpServer } from './index.js';
import { KimiClient } from './kimi/client.js';
import { KimiHttpClient } from './kimi/http.js';

const host = process.env.KIMI_MCP_HTTP_HOST?.trim() || '0.0.0.0';
const port = Number.parseInt(process.env.KIMI_MCP_HTTP_PORT ?? '3000', 10);
const authToken = process.env.KIMI_MCP_AUTH_TOKEN?.trim();

if (!authToken) {
  throw new Error('KIMI_MCP_AUTH_TOKEN is required for HTTP MCP transport');
}

const requiredAuthToken: string = authToken;

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid KIMI_MCP_HTTP_PORT: ${process.env.KIMI_MCP_HTTP_PORT}`);
}

const sessions = new Map<string, StreamableHTTPServerTransport>();
const fileTransfer = loadFileTransferConfig();

// Busy probe for the hosting layer: a sandbox must not sleep while Kimi works.
async function kimiBusy(): Promise<boolean> {
  const config = loadBridgeConfig();
  const kimi = new KimiClient(
    new KimiHttpClient(config.serverUrl, fetch, config.requestTimeoutMs, config.serverToken),
  );
  const { items } = await kimi.listSessions({ pageSize: 50, excludeEmpty: true });
  return items.some((session) => session.status === 'running');
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);

  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });

  res.end(text);
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return false;
  }

  const candidate = header.slice('Bearer '.length);
  const expected = Buffer.from(requiredAuthToken);
  const actual = Buffer.from(candidate);

  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 1024 * 1024;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > limit) {
      throw new Error('Request body exceeds 1 MiB limit');
    }

    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');

  if (!text) {
    return undefined;
  }

  return JSON.parse(text);
}

/**
 * Stateless MCP for fronting proxies that own the session layer (the
 * Cloudflare Worker answers initialize and tools/list itself so a sleeping
 * container is not woken, and it survives container restarts). Every request
 * gets a fresh server; the proxy passes the client name for tool selection.
 */
async function handleStatelessRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body: unknown;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendRpcError(
      res,
      400,
      -32700,
      error instanceof Error ? error.message : 'Invalid JSON',
    );
    return;
  }

  const clientHeader = req.headers['x-kimi-client-name'];
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const mcpServer = createMcpServer({
    fileTransfer,
    clientName: typeof clientHeader === 'string' && clientHeader ? clientHeader : undefined,
  });

  res.on('close', () => {
    void transport.close();
    void mcpServer.close();
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!authorized(req)) {
    res.setHeader('www-authenticate', 'Bearer realm="kimi-swarm-mcp"');
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.headers['x-kimi-mcp-mode'] === 'stateless') {
    await handleStatelessRequest(req, res);
    return;
  }

  const sessionHeader = req.headers['mcp-session-id'];
  const sessionId =
    typeof sessionHeader === 'string' ? sessionHeader : undefined;

  if (req.method === 'POST') {
    let body: unknown;

    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendRpcError(
        res,
        400,
        -32700,
        error instanceof Error ? error.message : 'Invalid JSON',
      );
      return;
    }

    if (sessionId) {
      const transport = sessions.get(sessionId);

      if (!transport) {
        sendRpcError(res, 404, -32001, 'Session not found');
        return;
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      sendRpcError(
        res,
        400,
        -32000,
        'Bad Request: Mcp-Session-Id header is required',
      );
      return;
    }

    let transport!: StreamableHTTPServerTransport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    const clientName = (body as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo?.name;
    const mcpServer = createMcpServer({
      fileTransfer,
      clientName: typeof clientName === 'string' ? clientName : undefined,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!sessionId) {
      sendRpcError(
        res,
        400,
        -32000,
        'Bad Request: Mcp-Session-Id header is required',
      );
      return;
    }

    const transport = sessions.get(sessionId);

    if (!transport) {
      sendRpcError(res, 404, -32001, 'Session not found');
      return;
    }

    await transport.handleRequest(req, res);
    return;
  }

  res.setHeader('allow', 'GET, POST, DELETE');
  sendJson(res, 405, { error: 'Method Not Allowed' });
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz' || req.url === '/ping') {
      sendJson(res, 200, {
        status: 'ok',
        transport: 'streamable-http',
      });
      return;
    }

    if (await handleFileRequest(fileTransfer, req, res)) {
      return;
    }

    if (req.url === '/activity') {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      sendJson(res, 200, { busy: await kimiBusy() });
      return;
    }

    if (req.url !== '/mcp') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    await handleMcpRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      sendRpcError(res, 500, -32603, 'Internal server error');
    } else if (!res.writableEnded) {
      res.end();
    }

    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
  }
});

async function shutdown(): Promise<void> {
  for (const transport of sessions.values()) {
    try {
      await transport.close();
    } catch {
      // Best-effort shutdown.
    }
  }

  sessions.clear();

  httpServer.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => {
  void shutdown();
});

process.on('SIGINT', () => {
  void shutdown();
});

httpServer.listen(port, host, () => {
  process.stderr.write(
    `Kimi swarm MCP listening on http://${host}:${port}/mcp\n`,
  );
});
