import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDownloadLink,
  createUploadLink,
  handleFileRequest,
  listWorkspaceFiles,
  safeFilename,
  signGrant,
  verifyGrant,
  type FileTransferConfig,
} from '../src/file-transfer.js';

let root: string;
let server: Server;
let config: FileTransferConfig;

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kimi-files-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });

  server = createServer(async (req, res) => {
    if (!(await handleFileRequest(config, req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  config = {
    key: randomBytes(32),
    sandboxId: 'user-test',
    publicBaseUrl: `http://127.0.0.1:${port}`,
    workspaceRoot,
    inputsDir: join(workspaceRoot, 'inputs'),
    usedNoncesDir: join(root, 'state', 'used'),
    maxUploadBytes: 1024 * 1024,
    uploadTtlSeconds: 900,
    downloadTtlSeconds: 3600,
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('upload links', () => {
  it('stores exact binary bytes and reports their SHA-256', async () => {
    const bytes = randomBytes(300_000);
    const link = await createUploadLink(config, { filename: 'archive.zip', sha256: sha(bytes) });

    const res = await fetch(link.uploadUrl, { method: 'PUT', body: bytes });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sha256).toBe(sha(bytes));
    expect(body.sizeBytes).toBe(bytes.length);
    expect(body.path).toBe(join(config.inputsDir, 'archive.zip'));
    expect(sha(await readFile(body.path))).toBe(sha(bytes));
  });

  it('is single-use', async () => {
    const link = await createUploadLink(config, { filename: 'a.txt' });
    expect((await fetch(link.uploadUrl, { method: 'PUT', body: 'one' })).status).toBe(201);
    expect((await fetch(link.uploadUrl, { method: 'PUT', body: 'two' })).status).toBe(409);
  });

  it('rejects bytes that do not match the declared SHA-256 and leaves no file', async () => {
    const link = await createUploadLink(config, { filename: 'doc.pdf', sha256: sha(Buffer.from('expected')) });
    const res = await fetch(link.uploadUrl, { method: 'PUT', body: 'tampered' });
    expect(res.status).toBe(422);
    expect((await listWorkspaceFiles(config)).items).toEqual([]);
  });

  it('enforces the size cap', async () => {
    const link = await createUploadLink(config, { filename: 'big.bin', maxBytes: 10 });
    const res = await fetch(link.uploadUrl, { method: 'PUT', body: randomBytes(11) });
    expect(res.status).toBe(413);
  });

  it('never overwrites an existing file', async () => {
    const first = await createUploadLink(config, { filename: 'same.txt' });
    const second = await createUploadLink(config, { filename: 'same.txt' });
    const a = await (await fetch(first.uploadUrl, { method: 'PUT', body: 'a' })).json();
    const b = await (await fetch(second.uploadUrl, { method: 'PUT', body: 'b' })).json();
    expect(a.path).not.toBe(b.path);
    expect(await readFile(a.path, 'utf8')).toBe('a');
    expect(await readFile(b.path, 'utf8')).toBe('b');
  });

  it('strips directory parts from file names', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..\\..\\evil.exe')).toBe('evil.exe');
    expect(safeFilename('.hidden')).toBe('hidden');
    expect(safeFilename('')).toBe('upload.bin');
  });
});

describe('link verification', () => {
  it('rejects tampered, foreign, and expired links', async () => {
    const link = await createUploadLink(config, { filename: 'x.txt' });
    const token = link.uploadUrl.split('/').pop()!;
    const [body, sig] = token.split('.');

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.path = '/etc/cron.d/evil';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect((await fetch(`${config.publicBaseUrl}/files/upload/${forged}`, { method: 'PUT', body: 'x' })).status).toBe(403);

    const foreign = signGrant({ ...payload, path: join(config.inputsDir, 'y'), sid: 'user-other' }, config.key);
    expect((await fetch(`${config.publicBaseUrl}/files/upload/${foreign}`, { method: 'PUT', body: 'x' })).status).toBe(403);

    const otherKey = signGrant({ ...payload, path: join(config.inputsDir, 'y') }, randomBytes(32));
    expect((await fetch(`${config.publicBaseUrl}/files/upload/${otherKey}`, { method: 'PUT', body: 'x' })).status).toBe(403);

    const expired = signGrant({ ...payload, path: join(config.inputsDir, 'y'), exp: 1 }, config.key);
    expect(() => verifyGrant(expired, config.key)).toThrow(/expired/);
  });
});

describe('download links', () => {
  it('serves the exact bytes with attachment headers', async () => {
    const bytes = randomBytes(50_000);
    await mkdir(join(config.workspaceRoot, 'out'), { recursive: true });
    await writeFile(join(config.workspaceRoot, 'out', 'report.pdf'), bytes);

    const link = await createDownloadLink(config, 'out/report.pdf');
    expect(link.sha256).toBe(sha(bytes));

    const res = await fetch(link.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('report.pdf');
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(bytes));
  });

  it('refuses paths outside the workspace, including through symlinks', async () => {
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(join(root, 'secret.txt'), join(config.workspaceRoot, 'link.txt'));

    await expect(createDownloadLink(config, '../secret.txt')).rejects.toThrow(/inside the workspace/);
    await expect(createDownloadLink(config, '/etc/passwd')).rejects.toThrow(/inside the workspace/);
    await expect(createDownloadLink(config, 'link.txt')).rejects.toThrow(/outside the workspace/);
  });

  it('rechecks the path when a signed link is used', async () => {
    const token = signGrant(
      { v: 1, op: 'down', sid: config.sandboxId, path: join(root, 'secret.txt'), exp: 9999999999, nonce: '00000000-0000-0000-0000-000000000000' },
      config.key,
    );
    await writeFile(join(root, 'secret.txt'), 'secret');
    expect((await fetch(`${config.publicBaseUrl}/files/download/${token}`)).status).toBe(400);
  });

  it('does not accept an upload link for downloads', async () => {
    const link = await createUploadLink(config, { filename: 'a.txt' });
    const token = link.uploadUrl.split('/').pop()!;
    expect((await fetch(`${config.publicBaseUrl}/files/download/${token}`)).status).toBe(405);
  });
});
