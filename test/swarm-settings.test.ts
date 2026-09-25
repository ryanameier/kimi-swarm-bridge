import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDelegationPrompt } from '../src/prompt.js';
import { loadOfferMode, loadSwarmLimits, saveMaxAgents, saveOfferMode } from '../src/swarm-settings.js';
import { OFFER_KIMI_INSTRUCTIONS } from '../src/file-tools.js';

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

describe('offering Kimi for parts of a request', () => {
  it('defaults to asking and keeps the preference alongside the agent limit', () => {
    const dir = stateDir();
    expect(loadOfferMode(dir)).toBe('ask');
    expect(saveOfferMode(dir, 'auto')).toBe('auto');
    saveMaxAgents(dir, 3, { KIMI_MAX_AGENTS_CAP: '20' });
    expect(loadOfferMode(dir)).toBe('auto');
    saveOfferMode(dir, 'off');
    expect(loadSwarmLimits(dir, { KIMI_MAX_AGENTS_CAP: '20' }).maxAgents).toBe(3);
  });

  it('tells Claude when to offer, how to ask, and how to run both parts at once', () => {
    expect(OFFER_KIMI_INSTRUCTIONS).toContain('offer to hand that part to Kimi while you work on the rest');
    expect(OFFER_KIMI_INSTRUCTIONS).toContain('ask (default) means offer and wait for a yes');
    expect(OFFER_KIMI_INSTRUCTIONS).toContain('call kimi_delegate_task first with a self-contained brief');
    expect(OFFER_KIMI_INSTRUCTIONS).toContain('Do not offer for quick or tightly coupled work');
  });
});
