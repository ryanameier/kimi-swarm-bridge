import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createDownloadLink,
  createUploadLink,
  listWorkspaceFiles,
  type FileTransferConfig,
} from './file-transfer.js';
import { runToolHandler } from './index.js';

/**
 * File exchange between the caller's environment and the hosted Kimi workspace.
 * Registered only when the bridge serves HTTP (the hosted runtime); local stdio
 * users already share a filesystem with Kimi.
 */
export const FILE_TOOL_METADATA = {
  kimi_create_upload_link: {
    title: 'Create Kimi File Upload Link',
    description: 'Create a single-use HTTPS link that places one file into the hosted Kimi workspace under /workspace/inputs. Call this when the user shares a file (chat attachment, local file, generated data) that Kimi should use: upload the exact bytes with an HTTP PUT whose body is the raw file (for example with the returned curl command from a code-execution or shell environment), then pass the returned destination path to Kimi in the task. The link expires after 15 minutes and accepts one upload. Supplying sha256 makes the server reject altered bytes. File bytes never travel through MCP tool arguments.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  kimi_create_download_link: {
    title: 'Create Kimi File Download Link',
    description: 'Create a short-lived HTTPS link to download one file that Kimi produced or received in its workspace (for example a report, spreadsheet, image, or ZIP under /workspace). Returns the URL, file name, size, and SHA-256 so the caller can verify the bytes. Give the link to the user or fetch it from a code-execution or shell environment to save the file locally. Paths outside /workspace are refused. The link is valid for one hour and can be fetched repeatedly until it expires.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  },
  kimi_list_files: {
    title: 'List Kimi Workspace Files',
    description: 'List files in the hosted Kimi workspace (default /workspace, recursively, skipping .git and dependency folders) with sizes and modification times. Use it to find deliverables after a Kimi task finishes, or to confirm an upload arrived, before creating download links. This tool is read-only and does not contact Kimi.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
} as const;

export function registerFileTools(server: McpServer, config: FileTransferConfig): void {
  server.registerTool(
    'kimi_create_upload_link',
    {
      ...FILE_TOOL_METADATA.kimi_create_upload_link,
      inputSchema: {
        filename: z.string().describe('Original file name including extension, for example report.pdf. Directory parts are stripped.'),
        sha256: z.string().optional().describe('Optional lowercase hex SHA-256 of the file. When supplied, the upload is rejected unless the received bytes match.'),
        maxBytes: z.number().optional().describe('Optional size cap in bytes; cannot exceed the deployment limit (100 MiB by default).'),
      },
    },
    async (input) => runToolHandler(() => createUploadLink(config, input)),
  );

  server.registerTool(
    'kimi_create_download_link',
    {
      ...FILE_TOOL_METADATA.kimi_create_download_link,
      inputSchema: {
        path: z.string().describe('File path inside the Kimi workspace, absolute (/workspace/out/report.pdf) or relative to /workspace.'),
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
}
