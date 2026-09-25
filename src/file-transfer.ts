import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/**
 * Signed, short-lived file transfer links.
 *
 * Token format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. The
 * payload's `sid` names the sandbox that issued it so a front proxy can route
 * the request (and verify the signature with its own derivation of the key)
 * before waking anything. The bridge verifies again and enforces path rules and
 * single use for uploads.
 */

export type GrantOp = 'up' | 'down';

export interface GrantPayload {
  v: 1;
  op: GrantOp;
  sid: string;
  /** Absolute destination (upload) or source (download) path. */
  path: string;
  exp: number;
  nonce: string;
  max?: number;
  sha256?: string;
}

export interface FileTransferConfig {
  key: Buffer;
  sandboxId: string;
  publicBaseUrl: string;
  workspaceRoot: string;
  inputsDir: string;
  usedNoncesDir: string;
  maxUploadBytes: number;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function loadFileTransferConfig(env: NodeJS.ProcessEnv = process.env): FileTransferConfig {
  const workspaceRoot = resolve(env.KIMI_WORKSPACE_ROOT?.trim() || '/workspace');
  const port = env.KIMI_MCP_HTTP_PORT?.trim() || '3000';
  const stateDir = env.KIMI_BRIDGE_STATE_DIR?.trim() || '/data/state';
  const keyHex = env.KIMI_FILE_GRANT_KEY?.trim();

  return {
    key: keyHex ? Buffer.from(keyHex, 'hex') : randomBytes(32),
    sandboxId: env.KIMI_SANDBOX_ID?.trim() || 'local',
    publicBaseUrl: (env.KIMI_PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, ''),
    workspaceRoot,
    inputsDir: join(workspaceRoot, 'inputs'),
    usedNoncesDir: join(stateDir, 'used-upload-grants'),
    maxUploadBytes: Number.parseInt(env.KIMI_MAX_UPLOAD_BYTES ?? '', 10) || DEFAULT_MAX_UPLOAD_BYTES,
    uploadTtlSeconds: 15 * 60,
    downloadTtlSeconds: 60 * 60,
  };
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

export function signGrant(payload: GrantPayload, key: Buffer): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyGrant(token: string, key: Buffer, now = Date.now()): GrantPayload {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) throw new GrantError(400, 'Malformed link');

  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new GrantError(403, 'Invalid link signature');
  }

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as GrantPayload;
  if (payload.v !== 1 || (payload.op !== 'up' && payload.op !== 'down')) {
    throw new GrantError(400, 'Unsupported link');
  }
  if (payload.exp * 1000 < now) throw new GrantError(410, 'Link expired');
  return payload;
}

export class GrantError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function safeFilename(raw: string): string {
  const name = basename(raw.replace(/\\/g, '/'))
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return name || 'upload.bin';
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/** Resolve a caller-supplied workspace path, rejecting anything outside the workspace (including via symlinks). */
export async function resolveWorkspaceFile(config: FileTransferConfig, rawPath: string): Promise<string> {
  const realRoot = await realpath(config.workspaceRoot);
  const candidate = resolve(config.workspaceRoot, rawPath);
  if (!isInside(config.workspaceRoot, candidate) && !isInside(realRoot, candidate)) {
    throw new GrantError(400, 'Path must be inside the workspace');
  }

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new GrantError(404, `File not found: ${rawPath}`);
  }
  if (!isInside(realRoot, real)) throw new GrantError(400, 'Path resolves outside the workspace');

  const info = await stat(real);
  if (!info.isFile()) throw new GrantError(400, 'Only regular files can be downloaded');
  return real;
}

async function uniqueDestination(dir: string, filename: string): Promise<string> {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = join(dir, i === 0 ? filename : `${stem} (${i})${ext}`);
    try {
      await lstat(candidate);
    } catch {
      return candidate;
    }
  }
  return join(dir, `${stem}-${randomUUID()}${ext}`);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export interface UploadLink {
  uploadUrl: string;
  method: 'PUT';
  destination: string;
  maxBytes: number;
  expiresAt: string;
  curl: string;
}

export async function createUploadLink(
  config: FileTransferConfig,
  input: { filename: string; sha256?: string; maxBytes?: number },
  now = Date.now(),
): Promise<UploadLink> {
  await mkdir(config.inputsDir, { recursive: true });
  const destination = await uniqueDestination(config.inputsDir, safeFilename(input.filename));
  const maxBytes = Math.min(input.maxBytes ?? config.maxUploadBytes, config.maxUploadBytes);
  const exp = Math.floor(now / 1000) + config.uploadTtlSeconds;
  const sha256 = input.sha256?.toLowerCase();
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new GrantError(400, 'sha256 must be 64 hex characters');
  }

  const token = signGrant(
    { v: 1, op: 'up', sid: config.sandboxId, path: destination, exp, nonce: randomUUID(), max: maxBytes, sha256 },
    config.key,
  );
  const uploadUrl = `${config.publicBaseUrl}/files/upload/${token}`;

  return {
    uploadUrl,
    method: 'PUT',
    destination,
    maxBytes,
    expiresAt: new Date(exp * 1000).toISOString(),
    curl: `curl --fail -sS -X PUT --data-binary @<local-file> '${uploadUrl}'`,
  };
}

export interface DownloadLink {
  downloadUrl: string;
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
}

export async function createDownloadLink(
  config: FileTransferConfig,
  rawPath: string,
  now = Date.now(),
): Promise<DownloadLink> {
  const path = await resolveWorkspaceFile(config, rawPath);
  const info = await stat(path);
  const exp = Math.floor(now / 1000) + config.downloadTtlSeconds;
  const token = signGrant({ v: 1, op: 'down', sid: config.sandboxId, path, exp, nonce: randomUUID() }, config.key);

  return {
    downloadUrl: `${config.publicBaseUrl}/files/download/${token}`,
    path,
    name: basename(path),
    sizeBytes: info.size,
    sha256: await sha256File(path),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export interface WorkspaceEntry {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

const LIST_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

export async function listWorkspaceFiles(
  config: FileTransferConfig,
  rawDir = '.',
  limit = 200,
): Promise<{ root: string; items: WorkspaceEntry[]; truncated: boolean }> {
  const root = resolve(config.workspaceRoot, rawDir);
  if (!isInside(config.workspaceRoot, root)) throw new GrantError(400, 'Directory must be inside the workspace');

  const items: WorkspaceEntry[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (LIST_SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (items.length >= limit) {
          truncated = true;
          return;
        }
        const info = await stat(full);
        items.push({ path: full, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  }

  await walk(root, 0);
  return { root, items, truncated };
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function consumeNonce(config: FileTransferConfig, nonce: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(nonce)) throw new GrantError(400, 'Malformed link');
  await mkdir(config.usedNoncesDir, { recursive: true });
  const marker = join(config.usedNoncesDir, nonce);
  try {
    // 'wx' fails if the marker exists, making each upload link single-use.
    await writeFile(marker, String(Date.now()), { flag: 'wx' });
  } catch {
    throw new GrantError(409, 'Upload link has already been used');
  }
}

/** Handle `/files/upload/<token>` and `/files/download/<token>`. Returns false if the URL is not a file route. */
export async function handleFileRequest(
  config: FileTransferConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const match = /^\/files\/(upload|download)\/([A-Za-z0-9_\-.]+)$/.exec(req.url?.split('?')[0] ?? '');
  if (!match) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  try {
    const grant = verifyGrant(match[2], config.key);
    if (grant.sid !== config.sandboxId) throw new GrantError(403, 'Link belongs to a different workspace');

    if (match[1] === 'upload') {
      if (grant.op !== 'up' || (req.method !== 'PUT' && req.method !== 'POST')) {
        throw new GrantError(405, 'Use PUT with the file bytes as the request body');
      }
      await receiveUpload(config, grant, req, res);
    } else {
      if (grant.op !== 'down' || (req.method !== 'GET' && req.method !== 'HEAD')) {
        throw new GrantError(405, 'Use GET');
      }
      await sendDownload(config, grant, req, res);
    }
  } catch (error) {
    if (!res.headersSent) {
      const status = error instanceof GrantError ? error.status : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.destroy();
    }
  }
  return true;
}

async function receiveUpload(
  config: FileTransferConfig,
  grant: GrantPayload,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const destination = resolve(grant.path);
  if (!isInside(config.workspaceRoot, destination)) throw new GrantError(400, 'Invalid destination');

  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
  const max = grant.max ?? config.maxUploadBytes;
  if (Number.isFinite(declared) && declared > max) throw new GrantError(413, `File exceeds ${max} bytes`);

  await consumeNonce(config, grant.nonce);
  await mkdir(dirname(destination), { recursive: true });

  const tmp = `${destination}.part-${randomUUID()}`;
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      size += chunk.length;
      if (size > max) {
        callback(new GrantError(413, `File exceeds ${max} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o644 }));
    const sha256 = hash.digest('hex');
    if (grant.sha256 && grant.sha256 !== sha256) {
      throw new GrantError(422, `SHA-256 mismatch: expected ${grant.sha256}, received ${sha256}`);
    }
    const final = await uniqueDestination(dirname(destination), basename(destination));
    await rename(tmp, final);
    sendJson(res, 201, { path: final, name: basename(final), sizeBytes: size, sha256 });
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function contentTypeFor(name: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function sendDownload(
  config: FileTransferConfig,
  grant: GrantPayload,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = await resolveWorkspaceFile(config, grant.path);
  const info = await stat(path);
  const name = basename(path);

  res.writeHead(200, {
    ...CORS_HEADERS,
    'content-type': contentTypeFor(name),
    'content-length': info.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(path), res);
}
