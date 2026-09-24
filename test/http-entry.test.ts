import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeKimiServer, type FakeKimiServer } from './fixtures/fake-kimi-server.js';

let child: ChildProcess | undefined;
let fakeKimi: FakeKimiServer | undefined;

async function getFreePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate test port');
  }

  const port = address.port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  return port;
}

async function waitForHealth(url: string, getStderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`HTTP MCP process exited early:\n${getStderr()}`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`HTTP MCP server did not become ready:\n${getStderr()}`);
}

function makeClient(url: string, token: string, name: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  );

  const client = new Client({
    name,
    version: '1.0.0',
  });

  return { client, transport };
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }

  child = undefined;

  if (fakeKimi) {
    await fakeKimi.close();
  }

  fakeKimi = undefined;
});

describe('HTTP MCP entrypoint', () => {
  it('requires bearer auth and supports fresh stateful MCP sessions', async () => {
    fakeKimi = await startFakeKimiServer();

    const port = await getFreePort();
    const token = 'test-http-mcp-token';
    let stderr = '';

    const processHandle = spawn(
      'pnpm',
      ['exec', 'tsx', 'src/http-entry.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KIMI_SERVER_URL: fakeKimi.url,
          KIMI_AUTO_START: 'false',
          KIMI_MCP_AUTH_TOKEN: token,
          KIMI_MCP_HTTP_HOST: '127.0.0.1',
          KIMI_MCP_HTTP_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child = processHandle;

    processHandle.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const mcpUrl = `${baseUrl}/mcp`;

    await waitForHealth(`${baseUrl}/healthz`, () => stderr);

    const ping = await fetch(`${baseUrl}/ping`);
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toEqual({
      status: 'ok',
      transport: 'streamable-http',
    });

    const unauthorized = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: {
            name: 'unauthorized-test',
            version: '1.0.0',
          },
        },
      }),
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('Bearer');

    const first = makeClient(mcpUrl, token, 'http-test-first');
    await first.client.connect(first.transport);

    const firstSessionId = first.transport.sessionId;

    expect(firstSessionId).toBeTruthy();

    const { tools } = await first.client.listTools();

    expect(tools.map((tool) => tool.name)).toContain('kimi_bridge_status');
    expect(tools.map((tool) => tool.name)).toContain('kimi_recent_jobs');
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'kimi_create_upload_link',
      'kimi_create_download_link',
      'kimi_list_files',
      'kimi_file_panel',
    ]));
    expect(tools).toHaveLength(16);

    const statusResult = await first.client.callTool({
      name: 'kimi_bridge_status',
      arguments: {},
    });

    const statusContent = statusResult.content as Array<{
      type: string;
      text?: string;
    }>;

    const statusText = statusContent.find(
      (item) => item.type === 'text',
    );

    expect(statusText?.type).toBe('text');

    const status = JSON.parse(statusText?.text ?? '{}');

    expect(status.status).toBe('ready');
    expect(status.healthzOk).toBe(true);
    expect(status.authOk).toBe(true);
    expect(status.serverVersion).toBe('0.27.0');

    await first.client.close();

    const second = makeClient(mcpUrl, token, 'http-test-second');
    await second.client.connect(second.transport);

    expect(second.transport.sessionId).toBeTruthy();
    expect(second.transport.sessionId).not.toBe(firstSessionId);

    await second.client.close();
  }, 20_000);
});
