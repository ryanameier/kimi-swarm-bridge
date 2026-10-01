import type { CatalogModel } from './model-pricing.js';
import type { ModelSettings } from './model-settings.js';

/**
 * Automatic model choice per task.
 *
 * Unless the user has pinned models with kimi_model_settings, Claude picks a
 * tier for each delegated task (the `modelTier` argument) and the bridge maps
 * it to ai& models:
 *
 * - economy:  coordinator on the deployment model, workers on DeepSeek V4 Flash.
 *             The default. Measured on the 30-item benchmark: about the same
 *             time and completeness as balanced at about 55% of the model
 *             cost, and correct verdicts on a 43-company criteria check.
 * - balanced: the deployment model for both.
 * - premium:  the deployment models with deep research (cross-checked
 *             sources) unless the task sets a depth. No stronger coordinator
 *             by default: Kimi K3 stalled as coordinator in our tests. Admins
 *             can set one with KIMI_MODEL_TIERS.
 *
 * Workers carry most of a swarm's tokens, so the worker model sets most of the
 * cost; the coordinator plans, splits the work and writes the result, so it
 * sets most of the quality. Admins can change the mapping with
 * KIMI_MODEL_TIERS (JSON, e.g. {"premium":{"coordinator":"moonshotai/kimi-k3"}})
 * and the default tier with KIMI_DEFAULT_MODEL_TIER.
 */

export const MODEL_TIERS = ['economy', 'balanced', 'premium'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface TierModels {
  /** ai& model id; omitted = the deployment model (KIMI_MODEL_NAME). */
  coordinator?: string;
  workers?: string;
}

export const DEFAULT_TIER_MODELS: Record<ModelTier, TierModels> = {
  economy: { workers: 'deepseek-ai/deepseek-v4-flash' },
  balanced: {},
  premium: {},
};

export const TIER_USE: Record<ModelTier, string> = {
  economy: 'most research, data collection and checking a provided list against criteria, plus extraction, formatting and mechanical screens (the default)',
  balanced: 'complex comparison or synthesis that needs nuanced judgment, or when an economy result came back thin',
  premium: 'high-stakes work where accuracy matters more than time and cost: deep, cross-checked research',
};

function isTier(value: unknown): value is ModelTier {
  return (MODEL_TIERS as readonly unknown[]).includes(value);
}

export function defaultTier(env: NodeJS.ProcessEnv = process.env): ModelTier {
  const value = env.KIMI_DEFAULT_MODEL_TIER?.trim();
  return isTier(value) ? value : 'economy';
}

/** The tier mapping with KIMI_MODEL_TIERS applied; malformed overrides are ignored. */
export function tierModels(env: NodeJS.ProcessEnv = process.env): Record<ModelTier, TierModels> {
  const tiers: Record<ModelTier, TierModels> = {
    economy: { ...DEFAULT_TIER_MODELS.economy },
    balanced: { ...DEFAULT_TIER_MODELS.balanced },
    premium: { ...DEFAULT_TIER_MODELS.premium },
  };
  const raw = env.KIMI_MODEL_TIERS?.trim();
  if (!raw) return tiers;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return tiers;
  }
  if (!parsed || typeof parsed !== 'object') return tiers;
  for (const [tier, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isTier(tier) || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    for (const role of ['coordinator', 'workers'] as const) {
      if (typeof entry[role] === 'string' && entry[role].trim()) tiers[tier][role] = entry[role].trim();
      else if (entry[role] === null) delete tiers[tier][role];
    }
  }
  return tiers;
}

export interface TaskModels {
  /** 'user' when the user pinned models with kimi_model_settings; then tier is ignored. */
  source: 'user' | 'auto';
  tier?: ModelTier;
  coordinatorModel: string | undefined;
  workerModel: string | undefined;
  /** Settings to render into Kimi's config for this task. */
  settings: ModelSettings;
  notes: string[];
}

export function isPinned(settings: ModelSettings): boolean {
  return settings.coordinatorModel !== undefined || settings.workerModel !== undefined;
}

/**
 * Models for one task. A user's pinned choice always wins. Otherwise the tier's
 * models are used when the catalog lists them as selectable; an unavailable
 * model falls back to the deployment model. selectable undefined = catalog unknown.
 */
export function resolveTaskModels(options: {
  saved: ModelSettings;
  requestedTier?: ModelTier;
  defaultModel: string | undefined;
  selectable?: CatalogModel[];
  env?: NodeJS.ProcessEnv;
}): TaskModels {
  const { saved, requestedTier, defaultModel, selectable } = options;
  const env = options.env ?? process.env;
  if (isPinned(saved)) {
    const coordinatorModel = saved.coordinatorModel ?? defaultModel;
    return {
      source: 'user',
      coordinatorModel,
      workerModel: saved.workerModel ?? coordinatorModel,
      settings: saved,
      notes: requestedTier ? [`The user chose fixed models in kimi_model_settings, so modelTier "${requestedTier}" was not applied.`] : [],
    };
  }

  const tier = requestedTier ?? defaultTier(env);
  const mapping = tierModels(env)[tier];
  const notes: string[] = [];
  const available = (id: string | undefined, role: string): string | undefined => {
    if (id === undefined || id === defaultModel) return undefined;
    if (selectable && !selectable.some((model) => model.id === id)) {
      notes.push(`${role} model ${id} is not available here; used the deployment model instead.`);
      return undefined;
    }
    return id;
  };
  const coordinator = available(mapping.coordinator, 'Coordinator');
  const workers = available(mapping.workers, 'Worker');
  const settings: ModelSettings = {};
  if (coordinator !== undefined) settings.coordinatorModel = coordinator;
  // Workers follow the coordinator unless set, so a stronger coordinator must pin workers explicitly.
  if (workers !== undefined) settings.workerModel = workers;
  else if (coordinator !== undefined && defaultModel !== undefined) settings.workerModel = defaultModel;
  return {
    source: 'auto',
    tier,
    coordinatorModel: coordinator ?? defaultModel,
    workerModel: workers ?? defaultModel,
    settings,
    notes,
  };
}

/**
 * Worker models that loop when one worker gets several items (seen with DeepSeek V4 Flash:
 * workers with two vendors each made 70+ calls and never finished). For these, the prompt
 * keeps one item per worker and runs extra AgentSwarm batches instead of grouping.
 * Admins can change the list with KIMI_SINGLE_ITEM_WORKER_MODELS (comma-separated ids).
 */
export function needsSingleItemWorkers(workerModel: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!workerModel) return false;
  const list = (env.KIMI_SINGLE_ITEM_WORKER_MODELS ?? 'deepseek-ai/deepseek-v4-flash').split(',').map((id) => id.trim()).filter(Boolean);
  return list.includes(workerModel);
}
