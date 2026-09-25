export interface PromptContext {
  /** Who delegates and reviews (defaults to Codex). */
  coordinator?: string;
  /** Hosted runtime: caller files arrive in /workspace/inputs; deliverables go to /workspace/outputs. */
  workspaceFiles?: boolean;
}

const WORKSPACE_FILES = `
Files:
Files shared by the user are in /workspace/inputs. Save every deliverable the user should receive in /workspace/outputs (create it if needed, use clear file names, do not overwrite inputs) and list those paths in the handoff.
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

When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring ${coordinator} review
${input.workspaceFiles ? WORKSPACE_FILES : ''}`;
}
