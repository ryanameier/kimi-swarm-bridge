export interface PromptContext {
  /** Who delegates and reviews (defaults to Codex). */
  coordinator?: string;
  /** Hosted runtime: caller files arrive in /workspace/inputs; deliverables go to /workspace/outputs. */
  workspaceFiles?: boolean;
  /** AgentSwarm ceiling and simultaneous-worker limit for this user. */
  swarmLimits?: { maxAgents: number; concurrency: number };
  /** How thorough research should be (default standard). */
  depth?: ResearchDepth;
}

export type ResearchDepth = 'quick' | 'standard' | 'deep';
export const RESEARCH_DEPTHS = ['quick', 'standard', 'deep'] as const;

const DEPTH_TEXT: Record<ResearchDepth, string> = {
  quick: 'use one authoritative source per item (official docs first), answer each requested point in a line, and write "not documented" instead of searching further',
  standard: 'use one or two authoritative sources per item (official docs first), answer each requested point briefly, and when a detail is still missing after one batch of searches and reads, write "not documented" and move on',
  deep: 'be thorough: cross-check important figures across several sources, keep notes under /tmp/notes as you go, and follow up on gaps',
};

function depthOf(context: PromptContext): ResearchDepth {
  return context.depth ?? 'standard';
}

/** Soft per-worker tool-call budget by depth; the slowest worker sets the swarm's finish time. */
export const WORKER_STEP_BUDGET: Record<ResearchDepth, number> = { quick: 5, standard: 8, deep: 14 };

function swarmLimitText(limits: PromptContext['swarmLimits'], depth: ResearchDepth = 'standard'): string {
  if (!limits) return '';
  return `Worker count: use only as many AgentSwarm workers as the task needs, never more than ${limits.maxAgents}. This overrides any default guidance to maximize or finely split agents. Do not use AgentSwarm for small or tightly coupled work. For independent items that each need web research, one worker per item (up to the ceiling) finishes fastest at about the same total cost; otherwise split so that no worker has much more work than the others. At most ${limits.concurrency} run at the same time; extra workers queue automatically.
Speed: start AgentSwarm right away unless the split is genuinely unclear. Call it exactly like this, with no other fields (a different shape is rejected and costs a retry):
{"description": "<short summary>", "prompt_template": "<shared instructions> Your scope: {{item}}", "items": ["<scope 1>", "<scope 2>"]}
prompt_template must contain {{item}} once; items are plain strings, at least 2, each different. Put the shared instructions in prompt_template, not in the items. Tell each worker to:
- finish in as few steps as possible: one batch of web_search queries, one or two batches of read_page calls (several pages per call, each with a specific question), then write all of its output in a single step;
- stop after about ${WORKER_STEP_BUDGET[depth]} tool calls: write what it has, mark anything still missing as "not found", and finish (the slowest worker decides when the whole swarm is done);
- for research depth "${depth}": ${DEPTH_TEXT[depth]};
- not inspect tool-result files, re-read its own output or re-verify, and never sleep or wait out rate limits (the tools retry on their own);
- when the deliverable is a document, write its finished section(s) to /workspace/outputs/.sections/<NN>-<topic>.md and return only a short summary plus one summary-table row per item.
Then finish in two steps: write the parts that need the whole picture (summary table built from the workers' rows, recommendations) in one file write, and assemble everything with one shell command that also deletes /workspace/outputs/.sections. Do not re-read or re-verify the assembled file.
`;
}

const WORKSPACE_FILES = `
Files:
Files shared by the user are in /workspace/inputs. Save every deliverable the user should receive in /workspace/outputs (create it if needed, use clear file names, do not overwrite inputs) and list those paths in the handoff.
Files in /workspace persist between sessions, but installed dependencies and caches (node_modules, .venv, __pycache__, .cache) do not; reinstall them when missing.
Web research: use web_search to find sources and read_page with a specific question to extract facts (it returns a short answer instead of the whole page). Batch: pass several queries or pages in one call. Do not sleep or poll to wait out rate limits.
`;

export interface DelegationPromptInput extends PromptContext {
  task: string;
  acceptanceCriteria: readonly string[];
  plan: readonly string[];
  swarmSuggestions?: readonly string[];
}

export interface ContinuePromptInput extends PromptContext {
  sessionId: string;
  task: string;
  acceptanceCriteria: readonly string[];
  plan: readonly string[];
  swarmSuggestions?: readonly string[];
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '- none' : items.map((item) => `- ${item}`).join('\n');
}

export function buildContinuationPrompt(input: ContinuePromptInput): string {
  const swarm =
    input.swarmSuggestions && input.swarmSuggestions.length > 0
      ? list(input.swarmSuggestions)
      : '- Use your judgment; avoid AgentSwarm for small or tightly coupled changes.';

  const coordinator = input.coordinator ?? 'Codex';
  return `This is a follow-up to a delegated task in session ${input.sessionId}. ${coordinator} has reviewed the work and is providing additional feedback.

Implement the requested changes in this repository. Do not change unrelated files.

Feedback:
${input.task}

Acceptance criteria:
${list(input.acceptanceCriteria)}

Plan from ${coordinator}:
${list(input.plan)}

Parallelization:
If the work has independent parts, use AgentSwarm. Suggested split:
${swarm}
${swarmLimitText(input.swarmLimits, depthOf(input))}
When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring ${coordinator} review
${input.workspaceFiles ? WORKSPACE_FILES : ''}`;
}

export function buildDelegationPrompt(input: DelegationPromptInput): string {
  const swarm =
    input.swarmSuggestions && input.swarmSuggestions.length > 0
      ? list(input.swarmSuggestions)
      : '- Use your judgment; avoid AgentSwarm for small or tightly coupled changes.';

  const coordinator = input.coordinator ?? 'Codex';
  return `You are the implementation worker. ${coordinator} is the coordinator and reviewer.

Implement the requested work in this repository. Do not change unrelated files.

Task:
${input.task}

Acceptance criteria:
${list(input.acceptanceCriteria)}

Plan from ${coordinator}:
${list(input.plan)}

Parallelization:
If the work has independent parts, use AgentSwarm. Suggested split:
${swarm}
${swarmLimitText(input.swarmLimits, depthOf(input))}
When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring ${coordinator} review
${input.workspaceFiles ? WORKSPACE_FILES : ''}`;
}
