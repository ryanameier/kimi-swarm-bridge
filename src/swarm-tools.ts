import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runToolHandler } from './index.js';
import { loadSwarmLimits, saveMaxAgents } from './swarm-settings.js';

export function registerSwarmSettingsTool(server: McpServer, stateDir: string): void {
  server.registerTool(
    'kimi_swarm_settings',
    {
      title: 'Kimi Swarm Agent Limits',
      description: 'Show or change how many AgentSwarm workers Kimi may use per task. maxAgents is a ceiling: Kimi still decides how many workers each task needs and uses fewer for small tasks. Call with maxAgents when the user asks to raise or lower the agent limit (for example "increase the limit to 20"); call with no arguments to report the current settings. Values above the deployment cap are reduced to the cap. The response also reports concurrency, the number of workers that run at the same time (set by the deployment admin); extra workers queue, which keeps simultaneous ai& requests bounded, and Kimi backs off automatically if ai& rate-limits.',
      inputSchema: {
        maxAgents: z.number().int().min(1).optional().describe('New ceiling on workers per task. Omit to only read the current settings.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => runToolHandler(async () => {
      if (input.maxAgents === undefined) {
        return { ...loadSwarmLimits(stateDir), note: 'maxAgents is a ceiling; Kimi decides the actual number per task.' };
      }
      const result = saveMaxAgents(stateDir, input.maxAgents);
      return {
        ...result,
        note: result.clamped
          ? `Requested ${result.requested} exceeds this deployment's cap; the ceiling is now ${result.maxAgents}.`
          : `Kimi may now use up to ${result.maxAgents} workers per task (it decides how many are needed); ${result.concurrency} run at a time.`,
      };
    }),
  );
}
