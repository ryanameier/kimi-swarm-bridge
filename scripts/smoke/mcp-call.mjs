#!/usr/bin/env node
// Minimal MCP client for smoke tests against a running bridge.
// Usage: MCP_URL=http://localhost:18080/mcp MCP_TOKEN=... node scripts/smoke/mcp-call.mjs <tool> '<json-args>'
//        node scripts/smoke/mcp-call.mjs --list
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://localhost:18080/mcp';
const token = process.env.MCP_TOKEN;
const [tool, rawArgs] = process.argv.slice(2);

if (!tool) {
  console.error('usage: mcp-call.mjs <tool> [json-args] | --list');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

try {
  if (tool === '--list') {
    const { tools } = await client.listTools();
    console.log(tools.map((t) => t.name).join('\n'));
  } else {
    const result = await client.callTool(
      { name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} },
      undefined,
      { timeout: 30 * 60_000, resetTimeoutOnProgress: true },
    );
    for (const part of result.content ?? []) {
      console.log(part.type === 'text' ? part.text : JSON.stringify(part));
    }
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
