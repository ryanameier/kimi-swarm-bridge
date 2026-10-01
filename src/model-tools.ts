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
import { defaultTier, isPinned, MODEL_TIERS, resolveTaskModels, TIER_USE } from './model-tiers.js';

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

/** What each tier resolves to here, with prices, for Claude to choose from and explain. */
function describeTiers(catalog: CatalogModel[], selectable: CatalogModel[], defaultModel: string | undefined, env: NodeJS.ProcessEnv) {
  const price = (id: string | undefined) => catalog.find((model) => model.id === id)?.pricing;
  return Object.fromEntries(MODEL_TIERS.map((tier) => {
    const task = resolveTaskModels({ saved: {}, requestedTier: tier, defaultModel, selectable, env });
    return [tier, {
      useFor: TIER_USE[tier],
      coordinatorModel: task.coordinatorModel,
      workerModel: task.workerModel,
      prices: { coordinator: price(task.coordinatorModel), workers: price(task.workerModel) },
      ...(task.notes.length > 0 ? { notes: task.notes } : {}),
    }];
  }));
}

export function registerModelSettingsTool(server: McpServer, options: ModelToolOptions): void {
  const env = options.env ?? process.env;
  server.registerTool(
    'kimi_model_settings',
    {
      title: 'Kimi Swarm Models',
      description: 'Show or change which ai& models Kimi uses. The coordinator plans the task, delegates to AgentSwarm workers and writes the result; the workers do the parallel work, and most of a swarm\'s tokens are theirs, so a cheaper worker model cuts cost the most. By default the choice is automatic (mode auto): each kimi_delegate_task call picks a modelTier (economy, balanced or premium) for what that task needs. Call with no arguments to see the mode, what each tier uses with prices (USD per million tokens), and the available models. Call with coordinatorModel and/or workerModel (model ids from the list) when the user wants specific models for every task (mode fixed; tiers are then ignored); use "default" to return the coordinator to the deployment default and "same" to make workers use the coordinator model. Call with mode "auto" when the user wants automatic choice back. The setting is per user and persists; changes apply to tasks started afterwards.',
      inputSchema: {
        coordinatorModel: z.string().min(1).optional().describe('ai& model id for the coordinator, or "default".'),
        workerModel: z.string().min(1).optional().describe('ai& model id for AgentSwarm workers, or "same" (use the coordinator model).'),
        mode: z.enum(['auto']).optional().describe('"auto" clears fixed models so each task picks its tier automatically.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => runToolHandler(async () => {
      const defaultModel = env.KIMI_MODEL_NAME;
      const catalog = await getModelCatalog(env);
      if (!catalog) throw new Error('The ai& model catalog is unavailable right now; try again shortly.');
      const selectable = selectableModels(catalog, env);
      const current = loadModelSettings(options.stateDir);

      const overview = (settings: ModelSettings) => isPinned(settings)
        ? { mode: 'fixed', ...effective(settings, defaultModel) }
        : { mode: 'auto', defaultTier: defaultTier(env), tiers: describeTiers(catalog, selectable, defaultModel, env) };

      if (input.mode === 'auto') {
        if (options.kimiCodeHome) writeKimiModelConfig(options.kimiCodeHome, renderKimiModelConfig({}, catalog, defaultModel, options.defaultThinking));
        saveModelSettings(options.stateDir, {});
        return { ...overview({}), note: 'Each task now picks its models automatically.' };
      }

      if (input.coordinatorModel === undefined && input.workerModel === undefined) {
        return {
          ...overview(current),
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
        mode: isPinned(next) ? 'fixed' : 'auto',
        ...result,
        prices: { coordinator: price(result.coordinatorModel), workers: price(result.workerModel) },
        note: isPinned(next)
          ? 'These models now apply to every Kimi task started from now on (automatic choice is off until mode "auto").'
          : 'Each task now picks its models automatically.',
      };
    }),
  );
}

/**
 * Re-render Kimi's model config from the saved settings, so settings written
 * by an older bridge pick up current defaults (for example the context window).
 * Called once at startup; failures only log.
 */
export async function applySavedModelSettings(options: ModelToolOptions): Promise<void> {
  const env = options.env ?? process.env;
  const settings = loadModelSettings(options.stateDir);
  if (!options.kimiCodeHome || (settings.coordinatorModel === undefined && settings.workerModel === undefined)) return;
  try {
    const catalog = await getModelCatalog(env);
    if (!catalog) return;
    writeKimiModelConfig(options.kimiCodeHome, renderKimiModelConfig(settings, catalog, env.KIMI_MODEL_NAME, options.defaultThinking));
  } catch (error) {
    process.stderr.write(`Could not apply saved model settings: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
