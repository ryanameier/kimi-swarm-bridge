import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createDownloadLink,
  createUploadLink,
  listWorkspaceFiles,
  type FileTransferConfig,
} from './file-transfer.js';
import { registerFilePanel } from './file-panel.js';
import { runToolHandler } from './index.js';

/**
 * File exchange between the caller's environment and the hosted Kimi workspace.
 * Registered only when the bridge serves HTTP (the hosted runtime); local stdio
 * users already share a filesystem with Kimi.
 */

export const OUTPUTS_DIR = '/workspace/outputs';

/** Sent to the client at initialize so the model knows when to suggest Kimi for part of a request. */
export const OFFER_KIMI_INSTRUCTIONS = `When to offer Kimi Swarm: Kimi works in the background in the user's own workspace while you keep going, so handing it an independent part of a request can finish the whole request sooner. It has about 2 minutes of fixed overhead and cannot see this conversation.

When a request (including one that does not mention Kimi) contains a substantial part that is independent of the rest and would take you several minutes (for example researching or comparing many items, reading a batch of documents, building a report, spreadsheet or other file, or a long coding task), offer to hand that part to Kimi while you work on the rest. Say in one sentence which part and why, for example: "Part 2, comparing the 20 vendors, doesn't depend on part 1. Should I hand it to Kimi Swarm so it runs while I work on part 1?" Do not offer for quick or tightly coupled work, or when the user wants the whole answer from you.

The user's preference is offerKimi in kimi_swarm_settings (read it once before your first offer in a conversation): ask (default) means offer and wait for a yes; auto means hand such parts over without asking and tell the user you did; off means use Kimi only when the user asks. If the user says to always do this or to stop asking, save that with kimi_swarm_settings.

When handing over a part: call kimi_delegate_task first with a self-contained brief (all the context Kimi needs, the exact deliverable and where to save it), then do your own part, then collect Kimi's result with kimi_wait_until_idle and kimi_get_handoff and combine both in your answer.`;

/** Sent to the client at initialize so the model knows when and how to move files. */
export const FILE_HANDOFF_INSTRUCTIONS = `Kimi Swarm runs in the user's own remote Linux workspace (/workspace). Kimi cannot see files in this conversation, in your code-execution environment, or on the user's device unless you transfer them.

Files in: when the user's request involves files they attached or uploaded (for example under /mnt/user-data/uploads) or files you created, transfer them before delegating. Compute each file's SHA-256, call kimi_create_upload_links once with all of them, then upload each file's exact bytes from code execution or a shell, e.g. curl --fail -X PUT --data-binary @<file> '<uploadUrl>'. Reference the returned /workspace/inputs paths in the Kimi task. Never paste file contents into tool arguments.

Deliverables: when the user wants a file (report, PDF, spreadsheet, chart, slides, code archive), ask Kimi to produce the finished file in /workspace/outputs as part of the task instead of recreating it yourself, then bring it back as described below.

Work: for anything longer than a minute use kimi_delegate_task, then call kimi_wait_until_idle repeatedly while it returns timeout (the job keeps running), then kimi_get_handoff. Kimi saves deliverables in /workspace/outputs.

Files out: when a finished task produced files the user wants, call kimi_create_download_links (defaults to /workspace/outputs), download each URL into your environment (for example into /mnt/user-data/outputs), check the SHA-256, and present the files in the conversation. If you cannot run code, share the links with the user.`;

/**
 * The file panel is an MCP App for clients whose sandbox lets apps pick and save
 * files. Claude's app sandbox blocks file pickers and declines panel downloads,
 * and Claude clients move files natively (code execution), so Claude gets no
 * panel. KIMI_FILE_PANEL=always|never overrides the client check.
 */
export function filePanelEnabled(clientName: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.KIMI_FILE_PANEL?.trim().toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return !/claude/i.test(clientName ?? '');
}

export const FILE_TOOL_METADATA = {
  kimi_create_upload_links: {
    title: 'Create Kimi File Upload Links',
    description: 'Create single-use HTTPS upload links that place files into the hosted Kimi workspace under /workspace/inputs. Call this whenever the user wants Kimi to use files they attached or uploaded, or files you produced: pass every file at once with its SHA-256, then PUT each file\'s raw bytes to its uploadUrl from code execution or a shell (the curl command is returned). Give Kimi the returned destination paths. Links expire after 15 minutes, accept one upload each, and reject bytes that do not match the SHA-256. File bytes never travel through MCP tool arguments.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  kimi_create_download_links: {
    title: 'Create Kimi File Download Links',
    description: 'Create short-lived HTTPS download links for files in the hosted Kimi workspace. Call this after a Kimi task finishes to collect its deliverables: with no arguments it covers everything in /workspace/outputs; pass paths for specific files. Returns each file\'s URL, name, size, and SHA-256. Download the files into your environment, verify the hashes, and present them to the user in the conversation. Paths outside /workspace are refused. Links stay valid for one hour.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  },
  kimi_create_upload_link: {
    title: 'Create Kimi File Upload Link',
    description: 'Single-file form of kimi_create_upload_links (kept for clients with cached tool lists). Creates one single-use HTTPS link that places a file into /workspace/inputs; PUT the raw bytes to uploadUrl from code execution or a shell, then give Kimi the destination path. Prefer kimi_create_upload_links for several files.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  kimi_create_download_link: {
    title: 'Create Kimi File Download Link',
    description: 'Single-file form of kimi_create_download_links (kept for clients with cached tool lists). Creates a one-hour HTTPS link, with size and SHA-256, for one file in the Kimi workspace; download it, verify the hash, and present the file to the user. Prefer kimi_create_download_links to collect all deliverables from /workspace/outputs.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  },
  kimi_list_files: {
    title: 'List Kimi Workspace Files',
    description: 'List files in the hosted Kimi workspace (default /workspace, recursively, skipping .git and dependency folders) with sizes and modification times. Use it to confirm uploads arrived or to find deliverables outside /workspace/outputs. This tool is read-only and does not contact Kimi.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
} as const;

export async function createDownloadLinks(
  config: FileTransferConfig,
  input: { paths?: string[]; dir?: string },
): Promise<{ files: Awaited<ReturnType<typeof createDownloadLink>>[]; note?: string }> {
  const paths = input.paths?.length
    ? input.paths
    : (await listWorkspaceFiles(config, input.dir ?? OUTPUTS_DIR, 50)).items.map((item) => item.path);

  if (paths.length === 0) {
    return { files: [], note: `No files found in ${input.dir ?? OUTPUTS_DIR}. Use kimi_list_files to locate deliverables.` };
  }
  return { files: await Promise.all(paths.map((path) => createDownloadLink(config, path))) };
}

export function registerFileTools(server: McpServer, config: FileTransferConfig, options: { panel?: boolean } = {}): void {
  server.registerTool(
    'kimi_create_upload_links',
    {
      ...FILE_TOOL_METADATA.kimi_create_upload_links,
      inputSchema: {
        files: z.array(z.object({
          filename: z.string().describe('Original file name including extension, for example report.pdf. Directory parts are stripped.'),
          sha256: z.string().optional().describe('Lowercase hex SHA-256 of the file. Strongly recommended: the upload is rejected unless the received bytes match.'),
          sizeBytes: z.number().optional().describe('File size in bytes; used as the upload size cap.'),
        })).min(1).max(50).describe('Every file to transfer, in one call.'),
      },
    },
    async (input) => runToolHandler(async () => ({
      uploads: await Promise.all(input.files.map((file) => createUploadLink(config, {
        filename: file.filename,
        sha256: file.sha256,
        maxBytes: file.sizeBytes,
      }))),
    })),
  );

  server.registerTool(
    'kimi_create_download_links',
    {
      ...FILE_TOOL_METADATA.kimi_create_download_links,
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Specific files, absolute (/workspace/outputs/report.pdf) or relative to /workspace. Omit to cover the directory.'),
        dir: z.string().optional().describe('Directory to cover when paths is omitted. Defaults to /workspace/outputs.'),
      },
    },
    async (input) => runToolHandler(() => createDownloadLinks(config, input)),
  );

  // Stable single-file names: clients cache tool lists, so renamed tools would
  // fail until they reconnect.
  server.registerTool(
    'kimi_create_upload_link',
    {
      ...FILE_TOOL_METADATA.kimi_create_upload_link,
      inputSchema: {
        filename: z.string().describe('Original file name including extension, for example report.pdf. Directory parts are stripped.'),
        sha256: z.string().optional().describe('Lowercase hex SHA-256 of the file; the upload is rejected unless the received bytes match.'),
        maxBytes: z.number().optional().describe('Optional size cap in bytes; cannot exceed the deployment limit.'),
      },
    },
    async (input) => runToolHandler(() => createUploadLink(config, input)),
  );

  server.registerTool(
    'kimi_create_download_link',
    {
      ...FILE_TOOL_METADATA.kimi_create_download_link,
      inputSchema: {
        path: z.string().describe('File path inside the Kimi workspace, absolute or relative to /workspace.'),
      },
    },
    async (input) => runToolHandler(() => createDownloadLink(config, input.path)),
  );

  server.registerTool(
    'kimi_list_files',
    {
      ...FILE_TOOL_METADATA.kimi_list_files,
      inputSchema: {
        dir: z.string().optional().describe('Directory inside the workspace to list, absolute or relative to /workspace. Defaults to the whole workspace.'),
        limit: z.number().optional().describe('Maximum number of files to return. Defaults to 200.'),
      },
    },
    async (input) => runToolHandler(() => listWorkspaceFiles(config, input.dir, input.limit)),
  );

  if (options.panel ?? true) {
    registerFilePanel(server, config);
  }
}
