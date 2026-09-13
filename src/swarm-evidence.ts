import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface InferenceEvidence {
  agentId: string;
  requestCount: number;
  providers: string[];
  models: string[];
  modelAliases: string[];
  thinkingEfforts: string[];
}

export interface SwarmWorkerEvidence extends InferenceEvidence {
  outcome?: string;
}

export interface SwarmEvidence {
  available: boolean;
  source: 'kimi_wire_v1';
  nativeAgentSwarmObserved: boolean;
  agentSwarmCallCount: number;
  requestedWorkerCount: number;
  workerCount: number;
  completedWorkerCount: number;
  coordinator?: InferenceEvidence;
  workers: SwarmWorkerEvidence[];
  unavailableReason?: 'session_wire_not_found' | 'wire_read_failed';
}

export interface ReadSwarmEvidenceInput {
  kimiCodeHome?: string;
  sessionId: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))].sort();
}

async function parseJsonLines(filePath: string): Promise<JsonRecord[]> {
  const text = await readFile(filePath, 'utf8');
  const records: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore a malformed/truncated line instead of discarding all evidence.
    }
  }
  return records;
}

function summarizeInference(records: JsonRecord[], fallbackAgentId: string): InferenceEvidence {
  const requests = records.filter((record) => record.type === 'llm.request');
  const strings = (key: string) => unique(requests.map((request) =>
    typeof request[key] === 'string' ? request[key] as string : undefined
  ));
  const agentId = requests.find((request) => typeof request.agentId === 'string')?.agentId;
  return {
    agentId: typeof agentId === 'string' ? agentId : fallbackAgentId,
    requestCount: requests.length,
    providers: strings('provider'),
    models: strings('model'),
    modelAliases: strings('modelAlias'),
    thinkingEfforts: strings('thinkingEffort'),
  };
}

function loopEvent(record: JsonRecord): JsonRecord | undefined {
  if (record.type !== 'context.append_loop_event' || !isRecord(record.event)) return undefined;
  return record.event;
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]+)"`).exec(tag);
  return match?.[1];
}

function workerResultsFromOutput(output: string): Map<string, string | undefined> {
  const workers = new Map<string, string | undefined>();
  for (const match of output.matchAll(/<subagent\b[^>]*>/g)) {
    const tag = match[0];
    const agentId = attr(tag, 'agent_id');
    if (agentId) workers.set(agentId, attr(tag, 'outcome'));
  }
  return workers;
}

async function findAgentsDir(kimiCodeHome: string, sessionId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined;
  const sessionsRoot = join(kimiCodeHome, 'sessions');
  const workspaceEntries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => undefined);
  if (!workspaceEntries) return undefined;
  for (const workspace of workspaceEntries) {
    if (!workspace.isDirectory()) continue;
    const agentsDir = join(sessionsRoot, workspace.name, sessionId, 'agents');
    const exists = await readdir(agentsDir).then(() => true, () => false);
    if (exists) return agentsDir;
  }
  return undefined;
}

export async function readSwarmEvidence(input: ReadSwarmEvidenceInput): Promise<SwarmEvidence> {
  const kimiCodeHome = input.kimiCodeHome ?? join(homedir(), '.kimi-code');
  const agentsDir = await findAgentsDir(kimiCodeHome, input.sessionId);
  if (!agentsDir) {
    return {
      available: false,
      source: 'kimi_wire_v1',
      nativeAgentSwarmObserved: false,
      agentSwarmCallCount: 0,
      requestedWorkerCount: 0,
      workerCount: 0,
      completedWorkerCount: 0,
      workers: [],
      unavailableReason: 'session_wire_not_found',
    };
  }

  let mainRecords: JsonRecord[];
  try {
    mainRecords = await parseJsonLines(join(agentsDir, 'main', 'wire.jsonl'));
  } catch {
    return {
      available: false,
      source: 'kimi_wire_v1',
      nativeAgentSwarmObserved: false,
      agentSwarmCallCount: 0,
      requestedWorkerCount: 0,
      workerCount: 0,
      completedWorkerCount: 0,
      workers: [],
      unavailableReason: 'wire_read_failed',
    };
  }

  const agentSwarmCalls = new Map<string, JsonRecord>();
  for (const record of mainRecords) {
    const event = loopEvent(record);
    if (!event || event.type !== 'tool.call' || event.name !== 'AgentSwarm') continue;
    if (typeof event.toolCallId === 'string') agentSwarmCalls.set(event.toolCallId, event);
  }

  let requestedWorkerCount = 0;
  for (const call of agentSwarmCalls.values()) {
    if (!isRecord(call.args)) continue;
    const items = call.args.items;
    const resumes = call.args.resume_agent_ids;
    requestedWorkerCount += Array.isArray(items) ? items.length : 0;
    requestedWorkerCount += isRecord(resumes) ? Object.keys(resumes).length : 0;
  }

  const workerOutcomes = new Map<string, string | undefined>();
  for (const record of mainRecords) {
    const event = loopEvent(record);
    if (!event || event.type !== 'tool.result') continue;
    if (typeof event.toolCallId !== 'string' || !agentSwarmCalls.has(event.toolCallId)) continue;
    if (!isRecord(event.result) || typeof event.result.output !== 'string') continue;
    for (const [agentId, outcome] of workerResultsFromOutput(event.result.output)) {
      workerOutcomes.set(agentId, outcome);
    }
  }

  const workers: SwarmWorkerEvidence[] = [];
  for (const agentId of [...workerOutcomes.keys()].sort()) {
    let records: JsonRecord[] = [];
    try {
      records = await parseJsonLines(join(agentsDir, agentId, 'wire.jsonl'));
    } catch {
      // Keep the worker record from AgentSwarm even if its wire file is unavailable.
    }
    const outcome = workerOutcomes.get(agentId);
    workers.push({
      ...summarizeInference(records, agentId),
      ...(outcome !== undefined ? { outcome } : {}),
    });
  }

  return {
    available: true,
    source: 'kimi_wire_v1',
    nativeAgentSwarmObserved: agentSwarmCalls.size > 0,
    agentSwarmCallCount: agentSwarmCalls.size,
    requestedWorkerCount,
    workerCount: workers.length,
    completedWorkerCount: workers.filter((worker) => worker.outcome === 'completed').length,
    coordinator: summarizeInference(mainRecords, 'main'),
    workers,
  };
}
