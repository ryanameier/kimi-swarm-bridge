import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSwarmEvidence } from '../src/swarm-evidence.js';

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
    await writeWire(home, sessionId, 'agent-0', [modelRequest('agent-0')]);
    await writeWire(home, sessionId, 'agent-1', [modelRequest('agent-1')]);

    const evidence = await readSwarmEvidence({ kimiCodeHome: home, sessionId });

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
        providers: ['openai'],
        models: ['moonshotai/kimi-k3'],
        modelAliases: ['__kimi_env_model__'],
        thinkingEfforts: ['high'],
      },
      workers: [
        {
          agentId: 'agent-0',
          requestCount: 1,
          providers: ['openai'],
          models: ['moonshotai/kimi-k3'],
          modelAliases: ['__kimi_env_model__'],
          thinkingEfforts: ['high'],
          outcome: 'completed',
        },
        {
          agentId: 'agent-1',
          requestCount: 1,
          providers: ['openai'],
          models: ['moonshotai/kimi-k3'],
          modelAliases: ['__kimi_env_model__'],
          thinkingEfforts: ['high'],
          outcome: 'completed',
        },
      ],
    });
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
});
