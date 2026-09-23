import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JobRegistry,
  defaultJobDatabasePath,
  type JobOwner,
} from '../src/job-registry.js';

describe('JobRegistry', () => {
  const tempDirs: string[] = [];
  const registries: JobRegistry[] = [];

  afterEach(() => {
    for (const registry of registries.splice(0)) {
      try {
        registry.close();
      } catch {
        // ignore cleanup failures
      }
    }

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }

    vi.unstubAllEnvs();
  });

  function makeDatabasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-job-registry-test-'));
    tempDirs.push(dir);
    return join(dir, 'jobs.sqlite');
  }

  function openRegistry(databasePath = makeDatabasePath()): JobRegistry {
    const registry = new JobRegistry(databasePath);
    registries.push(registry);
    return registry;
  }

  const owner: JobOwner = {
    organizationId: 'org-a',
    connectorInstanceId: 'connector-a',
  };

  it('uses the hosted default database path and supports an environment override', () => {
    expect(defaultJobDatabasePath()).toBe(
      '/data/kimi-swarm-bridge/jobs.sqlite',
    );

    vi.stubEnv('KIMI_JOB_DB_PATH', '/tmp/custom-jobs.sqlite');

    expect(defaultJobDatabasePath()).toBe('/tmp/custom-jobs.sqlite');
  });

  it('creates a durable job with expected initial state', () => {
    const registry = openRegistry();

    const job = registry.createJob({
      ...owner,
      userId: 'user-a',
      cwd: '/workspace',
      swarmMode: true,
    });

    expect(job.jobId).toMatch(/^job_[0-9a-f-]+$/);
    expect(job.kimiSessionId).toBeNull();
    expect(job.promptId).toBeNull();

    expect(job.organizationId).toBe('org-a');
    expect(job.userId).toBe('user-a');
    expect(job.connectorInstanceId).toBe('connector-a');

    expect(job.cwd).toBe('/workspace');
    expect(job.swarmMode).toBe(true);
    expect(job.status).toBe('created');

    expect(job.result).toBeNull();
    expect(job.error).toBeNull();

    expect(job.createdAt).toBeTruthy();
    expect(job.updatedAt).toBeTruthy();
  });

  it('persists a job after the registry is closed and reopened', () => {
    const databasePath = makeDatabasePath();

    const first = openRegistry(databasePath);

    const created = first.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: false,
    });

    first.bindSession(
      created.jobId,
      'session-persisted',
      'msg-persisted',
    );
    first.updateStatus(created.jobId, 'running');

    first.close();
    registries.splice(registries.indexOf(first), 1);

    const second = openRegistry(databasePath);
    const loaded = second.getJob(created.jobId);

    expect(loaded).toMatchObject({
      jobId: created.jobId,
      kimiSessionId: 'session-persisted',
      promptId: 'msg-persisted',
      organizationId: 'org-a',
      connectorInstanceId: 'connector-a',
      cwd: '/workspace',
      swarmMode: false,
      status: 'running',
    });
  });

  it('binds a Kimi session and resolves it through the owner', () => {
    const registry = openRegistry();

    const created = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: true,
    });

    const bound = registry.bindSession(
      created.jobId,
      'session-123',
      'msg-123',
    );

    expect(bound.kimiSessionId).toBe('session-123');
    expect(bound.promptId).toBe('msg-123');

    expect(
      registry.getOwnedJobBySession('session-123', owner),
    ).toEqual(bound);
  });

  it('enforces organization and connector ownership on lookups', () => {
    const registry = openRegistry();

    const created = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: false,
    });

    registry.bindSession(created.jobId, 'session-private');

    expect(registry.getOwnedJob(created.jobId, owner)?.jobId).toBe(
      created.jobId,
    );

    expect(
      registry.getOwnedJob(created.jobId, {
        organizationId: 'org-b',
        connectorInstanceId: 'connector-a',
      }),
    ).toBeUndefined();

    expect(
      registry.getOwnedJob(created.jobId, {
        organizationId: 'org-a',
        connectorInstanceId: 'connector-b',
      }),
    ).toBeUndefined();

    expect(
      registry.getOwnedJobBySession('session-private', {
        organizationId: 'org-b',
        connectorInstanceId: 'connector-a',
      }),
    ).toBeUndefined();
  });

  it('persists status, result, and error data', () => {
    const registry = openRegistry();

    const created = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: false,
    });

    expect(
      registry.updateStatus(created.jobId, 'running').status,
    ).toBe('running');

    const withResult = registry.storeResult(created.jobId, {
      finalMessage: 'DONE',
      changedFiles: [],
    });

    expect(withResult.result).toEqual({
      finalMessage: 'DONE',
      changedFiles: [],
    });
    expect(withResult.error).toBeNull();

    const withError = registry.storeError(created.jobId, {
      code: 'timeout',
      message: 'Client disconnected',
    });

    expect(withError.error).toEqual({
      code: 'timeout',
      message: 'Client disconnected',
    });
  });

  it('lists only jobs owned by the requested organization and connector', () => {
    const registry = openRegistry();

    const first = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: false,
    });

    const second = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: true,
    });

    registry.updateStatus(second.jobId, 'running');

    registry.createJob({
      organizationId: 'org-other',
      connectorInstanceId: 'connector-other',
      cwd: '/workspace',
      swarmMode: false,
    });

    const owned = registry.listOwnedJobs(owner);

    expect(owned.map((job) => job.jobId).sort()).toEqual(
      [first.jobId, second.jobId].sort(),
    );

    const running = registry.listOwnedJobs(owner, {
      status: 'running',
    });

    expect(running).toHaveLength(1);
    expect(running[0]?.jobId).toBe(second.jobId);
  });

  it('limits recent-job queries to a safe range', () => {
    const registry = openRegistry();

    for (let index = 0; index < 5; index += 1) {
      registry.createJob({
        ...owner,
        cwd: '/workspace',
        swarmMode: false,
      });
    }

    expect(registry.listOwnedJobs(owner, { limit: 2 })).toHaveLength(2);
    expect(registry.listOwnedJobs(owner, { limit: 0 })).toHaveLength(1);
  });

  it('throws when updating an unknown job', () => {
    const registry = openRegistry();

    expect(() =>
      registry.bindSession('job-missing', 'session-missing'),
    ).toThrow('Unknown job: job-missing');

    expect(() =>
      registry.updateStatus('job-missing', 'running'),
    ).toThrow('Unknown job: job-missing');

    expect(() =>
      registry.storeResult('job-missing', { ok: true }),
    ).toThrow('Unknown job: job-missing');

    expect(() =>
      registry.storeError('job-missing', { message: 'failed' }),
    ).toThrow('Unknown job: job-missing');
  });

  it('rejects binding the same Kimi session to two jobs', () => {
    const registry = openRegistry();

    const first = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: false,
    });

    const second = registry.createJob({
      ...owner,
      cwd: '/workspace',
      swarmMode: false,
    });

    registry.bindSession(first.jobId, 'session-unique');

    expect(() =>
      registry.bindSession(second.jobId, 'session-unique'),
    ).toThrow();
  });
});
