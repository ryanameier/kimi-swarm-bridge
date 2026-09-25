export interface ToolMetadata {
  title: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

export const TOOL_METADATA = {
  kimi_delegate_task: {
    title: 'Delegate Kimi Task',
    description: "Start or continue a Kimi task and return immediately. Use this for long-running or asynchronous work where the caller should receive identifiers before completion. Returns a durable jobId when durable jobs are configured, plus sessionId, promptId, status, and webUrl. After a disconnect or client timeout, recover with kimi_recent_jobs, then use kimi_wait_until_idle and kimi_get_handoff instead of submitting a duplicate prompt. The task may execute commands and modify files in cwd. With swarmMode=true the bridge verifies Kimi swarm mode before submission; final AgentSwarm execution evidence is available from the handoff. Also consider it when the user did not mention Kimi: if part of a request is substantial (would take you several minutes, e.g. researching or comparing many items, reading many documents, building a report or file) and independent of the rest, offer to hand that part to Kimi so it runs while you do the rest; ask first unless kimi_swarm_settings shows offerKimi auto (off: only when asked). If the user agrees, send a self-contained brief here first, then do your part.",
    annotations: MUTATING,
  },
  kimi_delegate_and_wait: {
    title: 'Delegate Kimi Task and Wait',
    description: "Start a Kimi task and wait until it becomes idle, blocked, failed, aborted, or the caller wait times out. Use this when the caller can remain connected for the expected task duration; prefer kimi_delegate_task for long-running work so the durable jobId is returned immediately. When durable jobs are configured, the result includes jobId. Idle results include handoff and review data; timeout does not abort the underlying Kimi session. After a client-side timeout or disconnect, use kimi_recent_jobs to recover the existing job rather than submitting the task again.",
    annotations: MUTATING,
  },
  kimi_wait_until_idle: {
    title: 'Wait for Kimi Session',
    description: "Poll an owned Kimi session until it is idle, awaiting approval, awaiting a question, failed, aborted, or the caller wait times out. Use the sessionId returned by delegation or recovered through kimi_recent_jobs. Returns normalized status and pending approval/question data when applicable. A timeout only ends this wait attempt; it does not abort the Kimi session or mark the durable job timed out. This tool does not modify workspace content.",
    annotations: READ_ONLY,
  },
  kimi_get_handoff: {
    title: 'Get Kimi Handoff',
    description: "Read the current or final handoff for an owned Kimi session. Use after kimi_wait_until_idle reports idle, or directly during recovery when the authoritative Kimi status and result need to be refreshed. Returns the assistant result, changed files, committed and working-tree changes, Git baseline evidence, and a fresh structured swarmEvidence snapshot. When durable jobs are configured, the bridge reconciles the durable status and caches the returned handoff. This tool does not submit another prompt or modify workspace content.",
    annotations: READ_ONLY,
  },
  kimi_review_package: {
    title: 'Build Kimi Review Package',
    description: "Build a reviewer-oriented snapshot for an owned Kimi session from its handoff, changed files, Git statistics, and review checklist. Use after delegated implementation work when concise review evidence is needed, or when a fresh review snapshot is required after recovery. If kimi_delegate_and_wait already returned reviewPackage, reuse that unless newer evidence is needed. When durable jobs are configured, the package is cached in the job registry. This tool does not modify the session or workspace.",
    annotations: READ_ONLY,
  },
  kimi_continue_task: {
    title: 'Continue Kimi Session',
    description: "Submit follow-up instructions to an owned existing Kimi session while preserving prior context. Use for corrections, additional work, or deliberate continuation of a recovered job instead of creating a duplicate session. Returns the new promptId and running status; when durable jobs are configured, the registry is updated to the new prompt and running state. The continuation may execute commands and modify files, and optional model, thinking, and swarm settings apply to the new prompt.",
    annotations: MUTATING,
  },
  kimi_get_diff: {
    title: 'Get Kimi File Diff',
    description: "Read the diff for one file in an owned Kimi session workspace. Use after kimi_get_handoff or kimi_review_package identifies a changed path and exact patch content is needed. Returns the requested path and diff content. This tool is read-only and does not modify the file, session, or durable job state.",
    annotations: READ_ONLY,
  },
  kimi_abort: {
    title: 'Abort Kimi Session',
    description: "Abort an owned Kimi session that should no longer continue running. Use only after confirming the intended session because this interrupts in-flight delegated work and changes session state. When durable jobs are configured, a successful abort is persisted as aborted. Returns the sessionId and explicit abort confirmation. Session history may remain available after the abort.",
    annotations: MUTATING,
  },
  kimi_bridge_status: {
    title: 'Check Kimi Bridge Status',
    description: "Check bridge and private Kimi-runtime readiness without submitting an LLM task. Use before delegation or when diagnosing connectivity, authentication, backend, or runtime problems. Returns health and auth status, safe Kimi backend/version metadata, diagnostics, and suggested next actions. It does not start a session, run AgentSwarm, expose credentials, or modify workspace content.",
    annotations: READ_ONLY,
  },
  kimi_recent_sessions: {
    title: 'List Recent Kimi Sessions',
    description: "List recent raw Kimi sessions with identifiers, statuses, titles, web links, and workspace metadata. Use this as a discovery fallback when durable job recovery is unavailable; when durable jobs are configured, prefer kimi_recent_jobs because it is connector-owned and persistent. Raw session discovery is not authorization: session-oriented tools still enforce durable ownership when configured. This tool only queries Kimi session metadata.",
    annotations: READ_ONLY,
  },
  kimi_recent_jobs: {
    title: 'List Recent Durable Jobs',
    description: "List recent connector-owned durable jobs from the persistent bridge registry. Use this first after a client timeout, disconnect, bridge restart, or lost response to recover the existing jobId and bound Kimi sessionId without guessing or submitting a duplicate task. Returns status, prompt/session identifiers, workspace, swarm mode, cached result or error data, and timestamps. It does not contact Kimi, so registry recovery remains available when the Kimi runtime is temporarily unavailable. This tool is read-only.",
    annotations: READ_ONLY,
  },

  kimi_find_recent_session: {
    title: 'Find Recent Kimi Session',
    description: "Find raw Kimi sessions whose titles contain a requested substring, optionally filtered by status and working directory. Use this only when the exact session is unknown and durable recovery through kimi_recent_jobs is unavailable or insufficient. Once a session is identified, prefer sessionId-based tools. Discovery does not grant ownership; session-oriented tools still enforce durable ownership when configured. This tool does not create or modify a session.",
    annotations: READ_ONLY,
  },
} satisfies Record<string, ToolMetadata>;
