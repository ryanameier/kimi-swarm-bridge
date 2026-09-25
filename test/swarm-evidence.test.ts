import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFailureReason, readSwarmEvidence } from '../src/swarm-evidence.js';
import { parseModelPricing } from '../src/model-pricing.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kimi-swarm-evidence-'));
  tmpDirs.push(home);
  return home;
}

async function writeWire(
  home: string,
  sessionId: string,
  agentId: string,
  records: unknown[],
): Promise<void> {
  const dir = join(home, 'sessions', 'wd_test', sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'wire.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

describe('readSwarmEvidence', () => {
  it('proves native AgentSwarm and reports coordinator and worker inference bindings', async () => {
    const home = await makeHome();
    const sessionId = 'session_test';
    const modelRequest = (agentId: string) => ({
      type: 'llm.request',
      agentId,
      provider: 'openai',
      model: 'moonshotai/kimi-k3',
      modelAlias: '__kimi_env_model__',
      thinkingEffort: 'high',
    });

    await writeWire(home, sessionId, 'main', [
      modelRequest('main'),
      {
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'tool.call',
          toolCallId: 'AgentSwarm:0',
          name: 'AgentSwarm',
          args: {
            description: 'two cases',
            prompt_template: 'Analyze {{item}}',
            items: ['A', 'B'],
          },
        },
      },
      {
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'tool.result',
          toolCallId: 'AgentSwarm:0',
          result: {
            output: '<agent_swarm_result><summary>completed: 2</summary>'
              + '<subagent agent_id="agent-0" item="A" outcome="completed">A</subagent>'
              + '<subagent agent_id="agent-1" item="B" outcome="completed">B</subagent>'
              + '</agent_swarm_result>',
          },
        },
      },
      modelRequest('main'),
    ]);
    const usage = (agentId: string, inputOther: number, inputCacheRead: number, output: number) => ({
      type: 'usage.record',
      agentId,
      model: 'moonshotai/kimi-k3',
      usage: { inputOther, inputCacheRead, inputCacheCreation: 0, output },
    });
    await writeWire(home, sessionId, 'agent-0', [modelRequest('agent-0'), usage('agent-0', 1_000_000, 0, 0)]);
    await writeWire(home, sessionId, 'agent-1', [modelRequest('agent-1'), usage('agent-1', 0, 2_000_000, 1_000_000)]);

    const evidence = await readSwarmEvidence({
      kimiCodeHome: home,
      sessionId,
      prices: new Map([['moonshotai/kimi-k3', { inputPer1M: 3, outputPer1M: 12.5, cachedInputPer1M: 0.5 }]]),
    });

    expect(evidence).toEqual({
      available: true,
      source: 'kimi_wire_v1',
      nativeAgentSwarmObserved: true,
      agentSwarmCallCount: 1,
      requestedWorkerCount: 2,
      workerCount: 2,
      completedWorkerCount: 2,
      coordinator: {
        agentId: 'main',
        requestCount: 2,
        usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        providers: ['openai'],
        models: ['moonshotai/kimi-k3'],
        modelAliases: ['__kimi_env_model__'],
        thinkingEfforts: ['high'],
      },
      workers: [
        {
          agentId: 'agent-0',
          requestCount: 1,
          usage: { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          providers: ['openai'],
          models: ['moonshotai/kimi-k3'],
          modelAliases: ['__kimi_env_model__'],
          thinkingEfforts: ['high'],
          outcome: 'completed',
        },
        {
          agentId: 'agent-1',
          requestCount: 1,
          usage: { inputTokens: 0, cachedInputTokens: 2_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
          providers: ['openai'],
          models: ['moonshotai/kimi-k3'],
          modelAliases: ['__kimi_env_model__'],
          thinkingEfforts: ['high'],
          outcome: 'completed',
        },
      ],
      // 1M uncached × $3 + 2M cached × $0.50 + 1M output × $12.50
      totalUsage: {
        requestCount: 4,
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        cacheWriteTokens: 0,
        outputTokens: 1_000_000,
        estimatedCostUsd: 16.5,
      },
    });
  });

  it('finds workers from their agent directories when the swarm result omits them', async () => {
    const home = await makeHome();
    const sessionId = 'session_dirs';
    await writeWire(home, sessionId, 'main', [{ type: 'llm.request', agentId: 'main' }]);
    await writeWire(home, sessionId, 'agent-0', [{ type: 'llm.request', agentId: 'agent-0' }]);
    await writeWire(home, sessionId, 'agent-7', [{ type: 'llm.request', agentId: 'agent-7' }]);
    const evidence = await readSwarmEvidence({ kimiCodeHome: home, sessionId });
    expect(evidence.workers.map((worker) => worker.agentId)).toEqual(['agent-0', 'agent-7']);
    expect(evidence.totalUsage?.requestCount).toBe(3);
  });

  it('reads model prices from an ai& /models listing', () => {
    const listing = { data: [{ id: 'moonshotai/kimi-k3', input_per_1m: '3.000000', output_per_1m: '12.500000', cached_input_per_1m: '0.500000' }] };
    expect(parseModelPricing(listing, 'moonshotai/kimi-k3')).toEqual({ inputPer1M: 3, outputPer1M: 12.5, cachedInputPer1M: 0.5 });
    expect(parseModelPricing(listing, 'other')).toBeUndefined();
    expect(parseModelPricing({}, 'moonshotai/kimi-k3')).toBeUndefined();
  });

  it('does not treat model text as native AgentSwarm evidence', async () => {
    const home = await makeHome();
    const sessionId = 'session_plain';
    await writeWire(home, sessionId, 'main', [
      {
        type: 'llm.request',
        agentId: 'main',
        provider: 'openai',
        model: 'moonshotai/kimi-k3',
        modelAlias: '__kimi_env_model__',
        thinkingEffort: 'high',
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I used four swarm workers.' }],
        },
      },
    ]);

    const evidence = await readSwarmEvidence({ kimiCodeHome: home, sessionId });

    expect(evidence.available).toBe(true);
    expect(evidence.nativeAgentSwarmObserved).toBe(false);
    expect(evidence.agentSwarmCallCount).toBe(0);
    expect(evidence.workerCount).toBe(0);
  });

  it('reports unavailable instead of fabricating evidence when the session wire is absent', async () => {
    const home = await makeHome();
    const evidence = await readSwarmEvidence({
      kimiCodeHome: home,
      sessionId: 'session_missing',
    });

    expect(evidence).toMatchObject({
      available: false,
      nativeAgentSwarmObserved: false,
      unavailableReason: 'session_wire_not_found',
    });
  });

  it('explains why the last turn failed', async () => {
    const home = await makeHome();
    await writeWire(home, 'session_failed', 'main', [
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' },
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'failed', error: { code: 'insufficient_credits', message: 'Insufficient credits. Add credits at https://console.aiand.com to continue.' } },
    ]);
    expect(await readFailureReason({ kimiCodeHome: home, sessionId: 'session_failed' }))
      .toBe('insufficient_credits: Insufficient credits. Add credits at https://console.aiand.com to continue.');

    await writeWire(home, 'session_ok', 'main', [{ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' }]);
    expect(await readFailureReason({ kimiCodeHome: home, sessionId: 'session_ok' })).toBeUndefined();
  });
});
