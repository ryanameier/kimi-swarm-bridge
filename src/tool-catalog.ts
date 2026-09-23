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
    description: 'Start or submit a Kimi task and return immediately with a durable job identifier when configured, plus session and prompt identifiers and current status. Use this for asynchronous workflows that will later call kimi_wait_until_idle or kimi_get_handoff; use kimi_delegate_and_wait when the result is needed in one call. The delegated task may run commands and modify files in cwd. With swarmMode=true the bridge verifies Kimi swarm mode before submission, but activation alone does not prove native AgentSwarm execution.',
    annotations: MUTATING,
  },
  kimi_delegate_and_wait: {
    title: 'Delegate Kimi Task and Wait',
    description: 'Start a Kimi task, wait for completion or another wait/terminal state, and return handoff and review data in one call. Prefer this for normal delegated work; use kimi_delegate_task when the caller needs immediate asynchronous control. The task may run commands and modify files. With swarmMode=true, structured swarmEvidence reports observed native AgentSwarm calls, worker counts, and coordinator/worker model-provider bindings when Kimi wire evidence is available.',
    annotations: MUTATING,
  },
  kimi_wait_until_idle: {
    title: 'Wait for Kimi Session',
    description: 'Poll an existing Kimi session until it is idle, times out, requires approval or a question response, is aborted, or fails. Use after kimi_delegate_task or after an earlier wait timed out. This is read-only with respect to session/workspace content and does not abort the job on timeout. Returns the normalized wait status and pending approval/question data when applicable.',
    annotations: READ_ONLY,
  },
  kimi_get_handoff: {
    title: 'Get Kimi Handoff',
    description: 'Read the current/final handoff for one Kimi session, including the assistant result, changed files, committed changes, working-tree changes, Git baseline evidence, and a fresh structured swarmEvidence snapshot. Use this after a long swarm times out: first call kimi_wait_until_idle on the same session, then call kimi_get_handoff to retrieve final native AgentSwarm worker/model evidence without submitting another prompt. Use kimi_review_package for a condensed reviewer-oriented package. This is read-only and does not modify the session or workspace.',
    annotations: READ_ONLY,
  },
  kimi_review_package: {
    title: 'Build Kimi Review Package',
    description: 'Build a read-only review package for one Kimi session by combining its handoff, changed files, Git statistics, and review checklist. Use after delegated implementation work when a reviewer needs concise evidence; if kimi_delegate_and_wait already returned an embedded reviewPackage, prefer that unless a fresh snapshot is needed. This tool does not modify files or session state.',
    annotations: READ_ONLY,
  },
  kimi_continue_task: {
    title: 'Continue Kimi Session',
    description: 'Submit follow-up instructions to an existing Kimi session while preserving its prior context. Use for corrections, additional work, or recovery after a failed/aborted task instead of creating an unnecessary duplicate session. The continuation may run commands and modify files, and optional model, thinking, and swarm settings are applied before prompt submission.',
    annotations: MUTATING,
  },
  kimi_get_diff: {
    title: 'Get Kimi File Diff',
    description: 'Read the diff for one file in a Kimi session workspace. Use after kimi_get_handoff or kimi_review_package identifies a changed path and exact patch content is needed. This is read-only; it does not modify the file or session. The path should refer to a file in the target session workspace.',
    annotations: READ_ONLY,
  },
  kimi_abort: {
    title: 'Abort Kimi Session',
    description: 'Abort an existing Kimi session that should no longer continue running. Use only after confirming the target session ID, because this changes session state and can interrupt in-flight commands or delegated work. Treat the action as destructive to the running job even though persisted session history may remain. Returns the session ID and explicit abort confirmation.',
    annotations: MUTATING,
  },
  kimi_bridge_status: {
    title: 'Check Kimi Bridge Status',
    description: 'Check live bridge and private Kimi-runtime readiness, including health/auth status, Kimi backend/version metadata, safe diagnostics, and suggested next actions. Use before delegation or when troubleshooting connectivity and authentication. This is read-only and does not submit an LLM task, start a swarm, expose credentials, or modify the workspace.',
    annotations: READ_ONLY,
  },
  kimi_recent_sessions: {
    title: 'List Recent Kimi Sessions',
    description: 'List recent Kimi sessions with identifiers, statuses, titles, web links, and workspace metadata. Use to discover an existing job before waiting, reviewing, continuing, aborting, or creating a possible duplicate; use kimi_find_recent_session when a title fragment is known. This is read-only and only queries Kimi session metadata.',
    annotations: READ_ONLY,
  },
  kimi_recent_jobs: {
    title: 'List Recent Durable Jobs',
    description: 'List recent connector-owned durable jobs from the persistent bridge registry, including job IDs, bound Kimi session and prompt IDs, status, workspace, swarm mode, cached result or error data, and timestamps. Use this for interruption or client-timeout recovery before falling back to raw Kimi session discovery. This is read-only and does not contact Kimi or modify session or workspace state.',
    annotations: READ_ONLY,
  },

  kimi_find_recent_session: {
    title: 'Find Recent Kimi Session',
    description: 'Find recent Kimi sessions whose titles contain a requested substring, optionally constrained by status and working directory. Use for interruption recovery or dedupe when the exact session ID is unknown; prefer session-ID-based tools once a match is known. This is read-only and returns matching candidates plus status-aware next-step guidance without creating or modifying a session.',
    annotations: READ_ONLY,
  },
} satisfies Record<string, ToolMetadata>;
