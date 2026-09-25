import { describe, expect, it } from 'vitest';
import { buildDelegationPrompt } from '../src/prompt.js';

describe('buildDelegationPrompt', () => {
  it('includes Codex/Kimi roles and handoff contract', () => {
    const prompt = buildDelegationPrompt({
      task: 'Add a health check endpoint.',
      acceptanceCriteria: ['GET /health returns ok'],
      plan: ['Add route', 'Add test'],
      swarmSuggestions: ['API route', 'test coverage'],
    });

    expect(prompt).toContain('Codex is the coordinator and reviewer');
    expect(prompt).toContain('Add a health check endpoint.');
    expect(prompt).toContain('GET /health returns ok');
    expect(prompt).toContain('If the work has independent parts, use AgentSwarm');
    expect(prompt).toContain('files changed');
    expect(prompt).toContain('tests run and results');
  });
});

describe('hosted prompt context', () => {
  it('names the coordinator and adds the inputs/outputs convention when configured', () => {
    const prompt = buildDelegationPrompt({
      task: 'Summarise the PDF.',
      acceptanceCriteria: [],
      plan: [],
      coordinator: 'Claude',
      workspaceFiles: true,
    });
    expect(prompt).toContain('Claude is the coordinator and reviewer');
    expect(prompt).not.toContain('Codex');
    expect(prompt).toContain('/workspace/inputs');
    expect(prompt).toContain('/workspace/outputs');
  });

  it('keeps the default Codex wording without file conventions', () => {
    const prompt = buildDelegationPrompt({ task: 'x', acceptanceCriteria: [], plan: [] });
    expect(prompt).toContain('Codex is the coordinator and reviewer');
    expect(prompt).not.toContain('/workspace/outputs');
  });
});

describe('swarm speed guidance', () => {
  const limits = { maxAgents: 20, concurrency: 20 };

  it('shows the exact AgentSwarm call shape so the first launch is accepted', () => {
    const prompt = buildDelegationPrompt({ task: 't', acceptanceCriteria: [], plan: [], swarmLimits: limits });
    expect(prompt).toContain('"prompt_template": "<shared instructions> Your scope: {{item}}"');
    expect(prompt).toContain('with no other fields');
  });

  it('gives workers a soft step budget that scales with depth', () => {
    const at = (depth: 'quick' | 'standard' | 'deep') =>
      buildDelegationPrompt({ task: 't', acceptanceCriteria: [], plan: [], swarmLimits: limits, depth });
    expect(at('quick')).toContain('stop after about 5 tool calls');
    expect(at('standard')).toContain('stop after about 8 tool calls');
    expect(at('deep')).toContain('stop after about 14 tool calls');
  });
});
