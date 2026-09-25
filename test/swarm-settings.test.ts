import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDelegationPrompt } from '../src/prompt.js';
import { loadSwarmLimits, saveMaxAgents } from '../src/swarm-settings.js';

const dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-settings-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('swarm limits', () => {
  it('defaults to a ceiling of 4 agents and 4 at a time', () => {
    expect(loadSwarmLimits(stateDir(), {})).toEqual({ maxAgents: 4, defaultMaxAgents: 4, maxAgentsCap: 32, concurrency: 4 });
  });

  it('persists a new ceiling and clamps it to the deployment cap', () => {
    const dir = stateDir();
    expect(saveMaxAgents(dir, 20, {})).toMatchObject({ maxAgents: 20, clamped: false });
    expect(loadSwarmLimits(dir, {}).maxAgents).toBe(20);

    expect(saveMaxAgents(dir, 50, { KIMI_MAX_AGENTS_CAP: '12' })).toMatchObject({ maxAgents: 12, clamped: true, requested: 50 });
    expect(loadSwarmLimits(dir, { KIMI_MAX_AGENTS_CAP: '8' }).maxAgents).toBe(8);
  });

  it('never exceeds the AgentSwarm item limit or accepts invalid values', () => {
    expect(loadSwarmLimits(stateDir(), { KIMI_MAX_AGENTS_CAP: '500' }).maxAgentsCap).toBe(128);
    expect(() => saveMaxAgents(stateDir(), 0, {})).toThrow(/at least 1/);
  });

  it('reads concurrency from the Kimi swarm setting', () => {
    expect(loadSwarmLimits(stateDir(), { KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '6' }).concurrency).toBe(6);
  });

  it('tells Kimi the ceiling is a maximum it decides within', () => {
    const prompt = buildDelegationPrompt({ task: 't', acceptanceCriteria: [], plan: [], swarmLimits: { maxAgents: 20, concurrency: 4 } });
    expect(prompt).toContain('never more than 20');
    expect(prompt).toContain('At most 4 run at the same time');
  });
});
