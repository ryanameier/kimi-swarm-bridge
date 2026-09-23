import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KimiApiError, KimiNetworkError } from '../src/errors.js';
import { createMcpServer, isDirectExecution, runToolHandler } from '../src/index.js';

describe('isDirectExecution', () => {
  it('returns true when the module URL matches the argv entry path and basename is index.js', () => {
    expect(isDirectExecution('file:///some/path/dist/index.js', '/some/path/dist/index.js')).toBe(true);
  });

  it('returns false when the module URL differs from the argv importer path', () => {
    // Importing dist/index.js from another entry (e.g. server.mjs) must not auto-start.
    expect(isDirectExecution('file:///some/path/dist/index.js', '/some/path/mcp/server.mjs')).toBe(false);
    expect(isDirectExecution('file:///some/path/dist/index.js', '/some/other/importer.mjs')).toBe(false);
  });

  it('returns false when the argv entry basename is not index.js', () => {
    expect(isDirectExecution('file:///some/path/mcp/server.mjs', '/some/path/mcp/server.mjs')).toBe(false);
    expect(isDirectExecution('file:///some/path/dist/index.mjs', '/some/path/dist/index.mjs')).toBe(false);
  });

  it('returns false for missing, empty, or invalid argv path', () => {
    expect(isDirectExecution('file:///some/path/dist/index.js', undefined)).toBe(false);
    expect(isDirectExecution('file:///some/path/dist/index.js', '')).toBe(false);
  });

  it('returns false for malformed module URLs', () => {
    expect(isDirectExecution('not-a-url', '/some/path/dist/index.js')).toBe(false);
    expect(isDirectExecution('', '/some/path/dist/index.js')).toBe(false);
  });

  it('compares normalized absolute paths', () => {
    expect(isDirectExecution('file:///some//path/./dist/index.js', '/some/path/dist/index.js')).toBe(true);
  });
});

describe('runToolHandler', () => {
  it('returns successful results as MCP text content', async () => {
    const result = await runToolHandler(async () => ({ ok: true }));
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    });
  });

  it('returns structured MCP errors for KimiApiError', async () => {
    const result = await runToolHandler(async () => {
      throw new KimiApiError(40001, 'bad request', 'req_123', { field: 'name' });
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'bad request',
      code: 40001,
      requestId: 'req_123',
      details: { field: 'name' },
    });
  });

  it('returns structured MCP errors for KimiNetworkError', async () => {
    const result = await runToolHandler(async () => {
      throw new KimiNetworkError('connection refused', new Error('ECONNREFUSED'));
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('connection refused');
    expect(parsed.code).toBe('NETWORK');
  });

  it('returns structured MCP errors for unexpected errors', async () => {
    const result = await runToolHandler(async () => {
      throw new Error('boom');
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('boom');
    expect(parsed.code).toBe('UNKNOWN');
  });
});

describe('createMcpServer durable job wiring', () => {
  it('creates the durable jobs database when ownership is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-index-jobs-test-'));
    const databasePath = join(dir, 'jobs.sqlite');

    vi.stubEnv('KIMI_JOB_DB_PATH', databasePath);
    vi.stubEnv('KIMI_ORGANIZATION_ID', 'org-test');
    vi.stubEnv('KIMI_CONNECTOR_INSTANCE_ID', 'connector-test');

    try {
      void createMcpServer();

      const db = new DatabaseSync(databasePath);

      try {
        const row = db
          .prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name = 'jobs'
          `)
          .get() as { name: string } | undefined;

        expect(row?.name).toBe('jobs');
      } finally {
        db.close();
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP server identity', () => {
  it('reports plugin version 0.3.3 in the source', () => {
    const source = readFileSync(resolve('src/index.ts'), 'utf8');
    expect(source).toContain("version: '0.3.3'");
  });
});
