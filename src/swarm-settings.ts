import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-user AgentSwarm limits.
 *
 * - maxAgents: the ceiling on workers per task. Kimi still decides how many a
 *   task needs; this only bounds it. Users change it from chat, within the
 *   deployment cap.
 * - concurrency: how many workers call the model at the same time (Kimi's
 *   KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY). Extra workers queue, so a high
 *   agent ceiling does not mean many simultaneous ai& requests. Set by the
 *   deployment, not from chat. Kimi also backs off automatically on HTTP 429.
 */

/** Kimi's AgentSwarm accepts at most 128 items per call. */
export const KIMI_SWARM_ITEM_LIMIT = 128;

export interface SwarmLimits {
  maxAgents: number;
  defaultMaxAgents: number;
  maxAgentsCap: number;
  concurrency: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function swarmSettingsPath(stateDir: string): string {
  return join(stateDir, 'swarm-settings.json');
}

export function loadSwarmLimits(stateDir: string, env: NodeJS.ProcessEnv = process.env): SwarmLimits {
  const maxAgentsCap = Math.min(positiveInt(env.KIMI_MAX_AGENTS_CAP, 32), KIMI_SWARM_ITEM_LIMIT);
  const concurrency = positiveInt(env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY, 4);
  const defaultMaxAgents = Math.min(positiveInt(env.KIMI_DEFAULT_MAX_AGENTS, 4), maxAgentsCap);

  let saved: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(swarmSettingsPath(stateDir), 'utf8')) as { maxAgents?: unknown };
    if (typeof parsed.maxAgents === 'number' && Number.isInteger(parsed.maxAgents) && parsed.maxAgents > 0) {
      saved = parsed.maxAgents;
    }
  } catch {
    // No saved preference.
  }

  return {
    maxAgents: Math.min(saved ?? defaultMaxAgents, maxAgentsCap),
    defaultMaxAgents,
    maxAgentsCap,
    concurrency,
  };
}

export function saveMaxAgents(
  stateDir: string,
  requested: number,
  env: NodeJS.ProcessEnv = process.env,
): SwarmLimits & { requested: number; clamped: boolean } {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error('maxAgents must be a whole number of at least 1.');
  }
  const { maxAgentsCap } = loadSwarmLimits(stateDir, env);
  const maxAgents = Math.min(requested, maxAgentsCap);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(swarmSettingsPath(stateDir), `${JSON.stringify({ maxAgents }, null, 2)}\n`);
  return { ...loadSwarmLimits(stateDir, env), requested, clamped: maxAgents !== requested };
}
