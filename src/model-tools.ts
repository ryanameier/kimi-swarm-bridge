import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runToolHandler } from './index.js';
import { getModelCatalog, type CatalogModel } from './model-pricing.js';
import {
  loadModelSettings,
  renderKimiModelConfig,
  saveModelSettings,
  selectableModels,
  writeKimiModelConfig,
  type ModelSettings,
} from './model-settings.js';

interface ModelToolOptions {
  stateDir: string;
  kimiCodeHome?: string;
  defaultThinking: string;
  env?: NodeJS.ProcessEnv;
}

function describeModel(model: CatalogModel) {
  return {
    id: model.id,
    ...(model.pricing
      ? {
          usdPerMillionTokens: {
            input: model.pricing.inputPer1M,
            cachedInput: model.pricing.cachedInputPer1M,
            output: model.pricing.outputPer1M,
          },
        }
      : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    capabilities: model.capabilities,
    reasoningEfforts: model.reasoningEfforts,
    ...(model.description ? { description: model.description } : {}),
  };
}

function effective(settings: ModelSettings, defaultModel: string | undefined) {
  const coordinator = settings.coordinatorModel ?? defaultModel ?? 'Kimi default';
  return { coordinatorModel: coordinator, workerModel: settings.workerModel ?? coordinator };
}

export function registerModelSettingsTool(server: McpServer, options: ModelToolOptions): void {
  const env = options.env ?? process.env;
  server.registerTool(
    'kimi_model_settings',
    {
      title: 'Kimi Swarm Models',
      description: 'Show or change which ai& models Kimi uses. The coordinator plans the task, delegates to AgentSwarm workers and writes the result; the workers do the parallel work, and most of a swarm\'s tokens are theirs, so a cheaper worker model cuts cost the most. Call with no arguments to list the available models with prices (USD per million tokens) and the current choice. Call with coordinatorModel and/or workerModel (model ids from the list) when the user asks to switch models; use "default" to return the coordinator to the deployment default and "same" to make workers use the coordinator model. Changes apply to tasks started afterwards; the setting is per user and persists.',
      inputSchema: {
        coordinatorModel: z.string().min(1).optional().describe('ai& model id for the coordinator, or "default".'),
        workerModel: z.string().min(1).optional().describe('ai& model id for AgentSwarm workers, or "same" (use the coordinator model).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => runToolHandler(async () => {
      const defaultModel = env.KIMI_MODEL_NAME;
      const catalog = await getModelCatalog(env);
      if (!catalog) throw new Error('The ai& model catalog is unavailable right now; try again shortly.');
      const selectable = selectableModels(catalog, env);
      const current = loadModelSettings(options.stateDir);

      if (input.coordinatorModel === undefined && input.workerModel === undefined) {
        return {
          ...effective(current, defaultModel),
          deploymentDefault: defaultModel,
          availableModels: selectable.map(describeModel),
        };
      }

      const pick = (id: string, role: string) => {
        if (!selectable.some((model) => model.id === id)) {
          throw new Error(`Unknown or unavailable ${role} model "${id}". Available: ${selectable.map((model) => model.id).join(', ')}`);
        }
        return id;
      };
      const next: ModelSettings = { ...current };
      if (input.coordinatorModel !== undefined) {
        if (input.coordinatorModel === 'default') delete next.coordinatorModel;
        else next.coordinatorModel = pick(input.coordinatorModel, 'coordinator');
      }
      if (input.workerModel !== undefined) {
        if (input.workerModel === 'same') delete next.workerModel;
        else next.workerModel = pick(input.workerModel, 'worker');
      }

      if (!options.kimiCodeHome) throw new Error('KIMI_CODE_HOME is not set, so worker models cannot be configured here.');
      writeKimiModelConfig(options.kimiCodeHome, renderKimiModelConfig(next, catalog, defaultModel, options.defaultThinking));
      saveModelSettings(options.stateDir, next);

      const result = effective(next, defaultModel);
      const price = (id: string) => catalog.find((model) => model.id === id)?.pricing;
      return {
        ...result,
        prices: { coordinator: price(result.coordinatorModel), workers: price(result.workerModel) },
        note: 'Applies to Kimi tasks started from now on. Running tasks keep their models.',
      };
    }),
  );
}
