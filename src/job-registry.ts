import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JobStatus =
  | "created"
  | "creating_session"
  | "running"
  | "idle"
  | "awaiting_approval"
  | "awaiting_question"
  | "failed"
  | "aborted";

export interface JobOwner {
  organizationId: string;
  connectorInstanceId: string;
}

export interface JobRecord {
  jobId: string;
  kimiSessionId: string | null;
  promptId: string | null;

  organizationId: string;
  userId: string | null;
  connectorInstanceId: string;

  cwd: string;
  swarmMode: boolean;

  status: JobStatus;
  result: unknown | null;
  error: unknown | null;

  createdAt: string;
  updatedAt: string;
}

export interface CreateJobInput extends JobOwner {
  userId?: string | null;
  cwd: string;
  swarmMode: boolean;
}

export interface ListOwnedJobsOptions {
  limit?: number;
  status?: JobStatus;
}

type JobRow = {
  job_id: string;
  kimi_session_id: string | null;
  prompt_id: string | null;

  organization_id: string;
  user_id: string | null;
  connector_instance_id: string;

  cwd: string;
  swarm_mode: number;

  status: JobStatus;
  result_json: string | null;
  error_json: string | null;

  created_at: string;
  updated_at: string;
};

export function defaultJobDatabasePath(): string {
  return (
    process.env.KIMI_JOB_DB_PATH ??
    "/data/kimi-swarm-bridge/jobs.sqlite"
  );
}

function parseJson(value: string | null): unknown | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    kimiSessionId: row.kimi_session_id,
    promptId: row.prompt_id,

    organizationId: row.organization_id,
    userId: row.user_id,
    connectorInstanceId: row.connector_instance_id,

    cwd: row.cwd,
    swarmMode: row.swarm_mode === 1,

    status: row.status,
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),

    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobRegistry {
  readonly databasePath: string;

  private readonly db: DatabaseSync;

  constructor(databasePath = defaultJobDatabasePath()) {
    this.databasePath = databasePath;

    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(databasePath);

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        kimi_session_id TEXT UNIQUE,
        prompt_id TEXT,

        organization_id TEXT NOT NULL,
        user_id TEXT,
        connector_instance_id TEXT NOT NULL,

        cwd TEXT NOT NULL,
        swarm_mode INTEGER NOT NULL DEFAULT 0
          CHECK (swarm_mode IN (0, 1)),

        status TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jobs_updated_at_idx
        ON jobs(updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_owner_idx
        ON jobs(
          organization_id,
          connector_instance_id,
          updated_at DESC
        );
    `);
  }

  close(): void {
    this.db.close();
  }

  createJob(input: CreateJobInput): JobRecord {
    const jobId = `job_${randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO jobs (
          job_id,
          kimi_session_id,
          prompt_id,
          organization_id,
          user_id,
          connector_instance_id,
          cwd,
          swarm_mode,
          status,
          result_json,
          error_json,
          created_at,
          updated_at
        )
        VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `)
      .run(
        jobId,
        input.organizationId,
        input.userId ?? null,
        input.connectorInstanceId,
        input.cwd,
        input.swarmMode ? 1 : 0,
        "created",
        now,
        now,
      );

    const job = this.getJob(jobId);

    if (!job) {
      throw new Error(`Failed to create durable job ${jobId}`);
    }

    return job;
  }

  getJob(jobId: string): JobRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT *
        FROM jobs
        WHERE job_id = ?
      `)
      .get(jobId) as JobRow | undefined;

    return row ? toJobRecord(row) : undefined;
  }

  getOwnedJob(
    jobId: string,
    owner: JobOwner,
  ): JobRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT *
        FROM jobs
        WHERE job_id = ?
          AND organization_id = ?
          AND connector_instance_id = ?
      `)
      .get(
        jobId,
        owner.organizationId,
        owner.connectorInstanceId,
      ) as JobRow | undefined;

    return row ? toJobRecord(row) : undefined;
  }

  getOwnedJobBySession(
    kimiSessionId: string,
    owner: JobOwner,
  ): JobRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT *
        FROM jobs
        WHERE kimi_session_id = ?
          AND organization_id = ?
          AND connector_instance_id = ?
      `)
      .get(
        kimiSessionId,
        owner.organizationId,
        owner.connectorInstanceId,
      ) as JobRow | undefined;

    return row ? toJobRecord(row) : undefined;
  }

  listOwnedJobs(
    owner: JobOwner,
    options: ListOwnedJobsOptions = {},
  ): JobRecord[] {
    const limit = Math.max(
      1,
      Math.min(Math.trunc(options.limit ?? 20), 100),
    );

    const rows = options.status
      ? this.db
          .prepare(`
            SELECT *
            FROM jobs
            WHERE organization_id = ?
              AND connector_instance_id = ?
              AND status = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `)
          .all(
            owner.organizationId,
            owner.connectorInstanceId,
            options.status,
            limit,
          )
      : this.db
          .prepare(`
            SELECT *
            FROM jobs
            WHERE organization_id = ?
              AND connector_instance_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `)
          .all(
            owner.organizationId,
            owner.connectorInstanceId,
            limit,
          );

    return (rows as JobRow[]).map(toJobRecord);
  }

  bindSession(
    jobId: string,
    kimiSessionId: string,
    promptId?: string | null,
  ): JobRecord {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(`
        UPDATE jobs
        SET kimi_session_id = ?,
            prompt_id = ?,
            updated_at = ?
        WHERE job_id = ?
      `)
      .run(
        kimiSessionId,
        promptId ?? null,
        now,
        jobId,
      );

    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    return this.getRequiredJob(jobId);
  }

  updateStatus(
    jobId: string,
    status: JobStatus,
  ): JobRecord {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(`
        UPDATE jobs
        SET status = ?,
            updated_at = ?
        WHERE job_id = ?
      `)
      .run(status, now, jobId);

    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    return this.getRequiredJob(jobId);
  }

  storeResult(
    jobId: string,
    resultValue: unknown,
  ): JobRecord {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(`
        UPDATE jobs
        SET result_json = ?,
            error_json = NULL,
            updated_at = ?
        WHERE job_id = ?
      `)
      .run(
        JSON.stringify(resultValue),
        now,
        jobId,
      );

    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    return this.getRequiredJob(jobId);
  }

  storeError(
    jobId: string,
    errorValue: unknown,
  ): JobRecord {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(`
        UPDATE jobs
        SET error_json = ?,
            updated_at = ?
        WHERE job_id = ?
      `)
      .run(
        JSON.stringify(errorValue),
        now,
        jobId,
      );

    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    return this.getRequiredJob(jobId);
  }

  private getRequiredJob(jobId: string): JobRecord {
    const job = this.getJob(jobId);

    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    return job;
  }
}
