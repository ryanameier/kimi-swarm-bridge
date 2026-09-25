import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runToolHandler } from './index.js';
import { loadOfferMode, loadSwarmLimits, OFFER_MODES, saveMaxAgents, saveOfferMode } from './swarm-settings.js';

export function registerSwarmSettingsTool(server: McpServer, stateDir: string): void {
  server.registerTool(
    'kimi_swarm_settings',
    {
      title: 'Kimi Swarm Settings',
      description: 'Show or change how many AgentSwarm workers Kimi may use per task. maxAgents is a ceiling: Kimi still decides how many workers each task needs and uses fewer for small tasks. Call with maxAgents when the user asks to raise or lower the agent limit (for example "increase the limit to 20"); call with no arguments to report the current settings. Values above the deployment cap are reduced to the cap. The response also reports concurrency, the number of workers that run at the same time (set by the deployment admin); extra workers queue, which keeps simultaneous ai& requests bounded, and Kimi backs off automatically if ai& rate-limits. offerKimi is the user\'s preference for Kimi taking independent parts of requests they did not send to Kimi: ask (default: offer and wait for a yes), auto (hand them over and say so) or off (only when the user asks for Kimi); read it before your first offer in a conversation, and save it when the user says to always do it or to stop asking.',
      inputSchema: {
        maxAgents: z.number().int().min(1).optional().describe('New ceiling on workers per task. Omit to only read the current settings.'),
        offerKimi: z.enum(OFFER_MODES).optional().describe('New preference for offering Kimi on parts of requests: ask, auto or off. Omit to keep it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => runToolHandler(async () => {
      const offerKimi = input.offerKimi === undefined ? loadOfferMode(stateDir) : saveOfferMode(stateDir, input.offerKimi);
      if (input.maxAgents === undefined) {
        return { ...loadSwarmLimits(stateDir), offerKimi, note: 'maxAgents is a ceiling; Kimi decides the actual number per task.' };
      }
      const result = saveMaxAgents(stateDir, input.maxAgents);
      return {
        ...result,
        offerKimi,
        note: result.clamped
          ? `Requested ${result.requested} exceeds this deployment's cap; the ceiling is now ${result.maxAgents}.`
          : `Kimi may now use up to ${result.maxAgents} workers per task (it decides how many are needed); ${result.concurrency} run at a time.`,
      };
    }),
  );
}
