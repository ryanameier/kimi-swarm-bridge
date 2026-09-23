import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TOOL_METADATA } from './tool-catalog.js';
import { createDefaultBaselineStore } from './baseline-store.js';
import { JobRegistry } from './job-registry.js';
import { loadBridgeConfig } from './config.js';
import { KimiApiError, KimiNetworkError } from './errors.js';
import { KimiHttpClient } from './kimi/http.js';
import { KimiClient } from './kimi/client.js';
import { createToolHandlers } from './tools.js';
import { KimiPreflight } from './preflight.js';

function summarizeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return String(cause);
}

export async function runToolHandler(handler: () => Promise<unknown>): Promise<{
  content: [{ type: 'text'; text: string }];
  isError?: true;
}> {
  try {
    const result = await handler();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof KimiApiError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message,
              code: error.code,
              requestId: error.requestId,
              details: error.details,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    if (error instanceof KimiNetworkError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message,
              code: 'NETWORK',
              cause: summarizeCause(error.cause),
              stack: error.stack,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: message,
            code: 'UNKNOWN',
            stack: error instanceof Error ? error.stack : undefined,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

export function createMcpServer(): McpServer {
  const config = loadBridgeConfig();
  const http = new KimiHttpClient(config.serverUrl, fetch, config.requestTimeoutMs, config.serverToken);
  const preflight = new KimiPreflight(config, http);
  const kimi = new KimiClient(http);
  const baselineStore = createDefaultBaselineStore(config);

  const organizationId = process.env.KIMI_ORGANIZATION_ID?.trim();
  const connectorInstanceId = process.env.KIMI_CONNECTOR_INSTANCE_ID?.trim();

  const jobRegistry = organizationId && connectorInstanceId
    ? new JobRegistry()
    : undefined;

  const jobOwner = organizationId && connectorInstanceId
    ? {
        organizationId,
        connectorInstanceId,
      }
    : undefined;

  const handlers = createToolHandlers({
    kimi,
    config,
    preflight,
    baselineStore,
    jobRegistry,
    jobOwner,
  });
  const server = new McpServer({ name: 'kimi-swarm-bridge', version: '0.3.3' });

  server.registerTool(
    'kimi_delegate_task',
    {
      ...TOOL_METADATA.kimi_delegate_task,
      inputSchema: {
        cwd: z.string().describe('Working directory visible to the Kimi runtime. In the managed hosted deployment use /workspace; local desktop paths are not automatically available to the remote runtime.'),
        task: z.string().describe('Concrete objective for Kimi to execute. Include the requested outcome and relevant constraints.'),
        acceptanceCriteria: z.array(z.string()).describe('Verifiable conditions that define successful completion. Pass an empty array only when there are genuinely no explicit acceptance checks.'),
        plan: z.array(z.string()).describe('Ordered implementation or analysis steps Kimi should follow. For swarm work, use distinct non-conflicting scopes that can be delegated to workers.'),
        swarmMode: z.boolean().optional().describe('Set true to activate and verify Kimi native swarm mode before prompt submission. Activation does not by itself prove AgentSwarm executed; use kimi_delegate_and_wait for structured swarm evidence.'),
        sessionId: z.string().optional().describe('Existing Kimi session ID to submit into. Omit for a fresh session; fresh sessions are recommended for new swarm jobs.'),
        model: z.string().optional().describe('Configured Kimi model alias. In the managed ai& deployment omit this field to use the centrally configured model binding; do not pass a raw provider model ID unless Kimi exposes it as an alias.'),
        thinking: z.string().optional().describe('Optional Kimi thinking setting. Omit to use the bridge default; the managed pilot is configured for high thinking.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_delegate_task(input)),
  );

  server.registerTool(
    'kimi_delegate_and_wait',
    {
      ...TOOL_METADATA.kimi_delegate_and_wait,
      inputSchema: {
        cwd: z.string().describe('Working directory visible to the Kimi runtime. In the managed hosted deployment use /workspace; local desktop paths are not automatically available to the remote runtime.'),
        task: z.string().describe('Concrete objective for Kimi to execute. Include the requested outcome and relevant constraints.'),
        acceptanceCriteria: z.array(z.string()).describe('Verifiable conditions that define successful completion. Pass an empty array only when there are genuinely no explicit acceptance checks.'),
        plan: z.array(z.string()).describe('Ordered implementation or analysis steps Kimi should follow. For swarm work, use distinct non-conflicting scopes that can be delegated to workers.'),
        timeoutMs: z.number().optional().describe('Maximum time in milliseconds to wait for this call. A timeout returns control without aborting the Kimi session, so the same session can be waited on later.'),
        swarmMode: z.boolean().optional().describe('Set true to activate and verify Kimi native swarm mode before prompt submission. When true, the result includes structured swarmEvidence when Kimi wire records are available.'),
        sessionId: z.string().optional().describe('Existing Kimi session ID to submit into. Omit for a fresh session; fresh sessions are recommended for new swarm jobs.'),
        model: z.string().optional().describe('Configured Kimi model alias. In the managed ai& deployment omit this field to use the centrally configured model binding; do not pass a raw provider model ID unless Kimi exposes it as an alias.'),
        thinking: z.string().optional().describe('Optional Kimi thinking setting. Omit to use the bridge default; the managed pilot is configured for high thinking.'),
        dedupe: z.object({
          titleContains: z.string().describe('Case-insensitive substring used to find an existing recent session before creating a new one. Use a task-specific title fragment.'),
          status: z.string().optional().describe('Optional exact Kimi session-status filter, such as running, idle, awaiting_approval, awaiting_question, aborted, or failed.'),
          pageSize: z.number().optional().describe('Maximum number of recent sessions to inspect for a title match. Defaults to 20.'),
          includeArchive: z.boolean().optional().describe('Whether archived sessions should be included in the dedupe search.'),
          excludeEmpty: z.boolean().optional().describe('Whether sessions with no messages should be excluded from the dedupe search.'),
          reuseIfStatus: z.array(z.string()).optional().describe('Statuses the caller permits for reuse. The bridge still only auto-reuses running, idle, awaiting_approval, and awaiting_question sessions.'),
          matchAnyCwd: z.boolean().optional().describe('Set true only when intentionally allowing reuse from a different working directory. Defaults to false for workspace safety.'),
          includeSummary: z.boolean().optional().describe('Fetch recent user/assistant summary data for candidate sessions. Adds latency; leave false for normal dedupe checks.'),
        }).optional().describe('Optional duplicate-session guard. When supplied, the bridge searches recent sessions before creating a new session and may reuse a compatible match.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_delegate_and_wait(input)),
  );

  server.registerTool(
    'kimi_wait_until_idle',
    {
      ...TOOL_METADATA.kimi_wait_until_idle,
      inputSchema: {
        sessionId: z.string().describe('Kimi session ID returned by delegation or session-discovery tools.'),
        timeoutMs: z.number().optional().describe('Maximum time in milliseconds to poll before returning timeout. Timeout does not abort or otherwise mutate the session.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_wait_until_idle(input)),
  );

  server.registerTool(
    'kimi_get_handoff',
    {
      ...TOOL_METADATA.kimi_get_handoff,
      inputSchema: {
        sessionId: z.string().describe('Kimi session ID whose current/final result and Git-change evidence should be retrieved.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_get_handoff(input)),
  );

  server.registerTool(
    'kimi_review_package',
    {
      ...TOOL_METADATA.kimi_review_package,
      inputSchema: {
        sessionId: z.string().describe('Kimi session ID to package for review. Normally use a session that is idle or otherwise finished producing changes.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_review_package(input)),
  );

  server.registerTool(
    'kimi_continue_task',
    {
      ...TOOL_METADATA.kimi_continue_task,
      inputSchema: {
        sessionId: z.string().describe('Existing Kimi session ID whose context should be preserved for the follow-up task.'),
        task: z.string().describe('Follow-up instruction, correction, or additional work to perform in the existing session.'),
        acceptanceCriteria: z.array(z.string()).optional().describe('Optional verifiable conditions for the follow-up work.'),
        plan: z.array(z.string()).optional().describe('Optional ordered steps for the follow-up work.'),
        swarmMode: z.boolean().optional().describe('Optional swarm-mode setting to verify before the continuation prompt. Set true only when the follow-up should allow native AgentSwarm.'),
        model: z.string().optional().describe('Configured Kimi model alias. In the managed ai& deployment omit this field to keep the centrally configured model binding.'),
        thinking: z.string().optional().describe('Optional Kimi thinking setting. Omit to keep the bridge default.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_continue_task(input)),
  );

  server.registerTool(
    'kimi_get_diff',
    {
      ...TOOL_METADATA.kimi_get_diff,
      inputSchema: {
        sessionId: z.string().describe('Kimi session ID that owns the workspace/file change.'),
        path: z.string().describe('Workspace-relative file path whose diff should be returned. Prefer a path reported by kimi_get_handoff or kimi_review_package.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_get_diff(input)),
  );

  server.registerTool(
    'kimi_abort',
    {
      ...TOOL_METADATA.kimi_abort,
      inputSchema: {
        sessionId: z.string().describe('Kimi session ID to stop. Use the ID returned by delegation or session-discovery tools and confirm it is the intended running job.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_abort(input)),
  );

  server.registerTool(
    'kimi_bridge_status',
    {
      ...TOOL_METADATA.kimi_bridge_status,
    },
    async () => runToolHandler(() => handlers.kimi_bridge_status()),
  );

  server.registerTool(
    'kimi_recent_jobs',
    {
      ...TOOL_METADATA.kimi_recent_jobs,
      inputSchema: {
        pageSize: z.number().optional().describe('Maximum number of connector-owned durable jobs to return. Defaults to 10 and is capped by the registry at 100.'),
        status: z.enum([
          'created',
          'creating_session',
          'running',
          'idle',
          'awaiting_approval',
          'awaiting_question',
          'failed',
          'aborted',
        ]).optional().describe('Optional durable job-status filter.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_recent_jobs(input)),
  );

  server.registerTool(
    'kimi_recent_sessions',
    {
      ...TOOL_METADATA.kimi_recent_sessions,
      inputSchema: {
        pageSize: z.number().optional().describe('Maximum number of recent sessions to return. Defaults to 10.'),
        status: z.string().optional().describe('Optional exact Kimi session-status filter, such as running, idle, awaiting_approval, awaiting_question, aborted, or failed.'),
        includeArchive: z.boolean().optional().describe('Whether archived Kimi sessions should be included.'),
        excludeEmpty: z.boolean().optional().describe('Whether sessions with no messages should be excluded.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_recent_sessions(input)),
  );

  server.registerTool(
    'kimi_find_recent_session',
    {
      ...TOOL_METADATA.kimi_find_recent_session,
      inputSchema: {
        titleContains: z.string().describe('Case-insensitive substring that must appear in the Kimi session title. Leading and trailing whitespace is ignored.'),
        status: z.string().optional().describe('Optional exact Kimi session-status filter, such as running, idle, awaiting_approval, awaiting_question, aborted, or failed.'),
        pageSize: z.number().optional().describe('Maximum number of recent sessions to inspect. Defaults to 20.'),
        includeArchive: z.boolean().optional().describe('Whether archived Kimi sessions should be included in the search.'),
        excludeEmpty: z.boolean().optional().describe('Whether sessions with no messages should be excluded from the search.'),
        cwd: z.string().optional().describe('Optional working directory used to constrain matches to the same workspace. Recommended for safe recovery/dedupe.'),
        matchAnyCwd: z.boolean().optional().describe('Set true only when intentionally allowing a title match from any working directory. Defaults to false when cwd is provided.'),
        includeSummary: z.boolean().optional().describe('Fetch message count and latest meaningful user/assistant messages for candidates. Adds latency; leave false unless recovery context is needed.'),
      },
    },
    async (input) => runToolHandler(() => handlers.kimi_find_recent_session(input)),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

export function isDirectExecution(
  metaUrl: string,
  argvPath: string | undefined = process.argv[1],
): boolean {
  if (!argvPath || basename(argvPath) !== 'index.js') {
    return false;
  }
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
