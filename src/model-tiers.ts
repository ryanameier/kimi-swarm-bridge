import type { CatalogModel } from './model-pricing.js';
import type { ModelSettings } from './model-settings.js';

/**
 * Automatic model choice per task.
 *
 * Unless the user has pinned models with kimi_model_settings, Claude picks a
 * tier for each delegated task (the `modelTier` argument) and the bridge maps
 * it to ai& models:
 *
 * - economy:  coordinator on the deployment model, workers on a low-cost model.
 *             For simple, well-specified work: lookups, extraction, checking a
 *             provided list, formatting, mechanical pre-screens.
 * - balanced: the deployment model for both (today's behaviour). Typical
 *             research and comparison that needs judgment.
 * - premium:  a stronger coordinator, workers on the deployment model. Hard
 *             reasoning, complex synthesis, high-stakes or coding work.
 *
 * Workers carry most of a swarm's tokens, so the worker model sets most of the
 * cost; the coordinator plans, splits the work and writes the result, so it
 * sets most of the quality. Admins can change the mapping with
 * KIMI_MODEL_TIERS (JSON, e.g. {"economy":{"workers":"openai/gpt-oss-120b"}})
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
  premium: { coordinator: 'moonshotai/kimi-k3' },
};

export const TIER_USE: Record<ModelTier, string> = {
  economy: 'simple, well-specified work: lookups, checking or extracting data from a provided list, formatting, mechanical screens',
  balanced: 'typical research and comparison that needs judgment (the default)',
  premium: 'hard reasoning, complex synthesis across many sources, high-stakes or coding work',
};

function isTier(value: unknown): value is ModelTier {
  return (MODEL_TIERS as readonly unknown[]).includes(value);
}

export function defaultTier(env: NodeJS.ProcessEnv = process.env): ModelTier {
  const value = env.KIMI_DEFAULT_MODEL_TIER?.trim();
  return isTier(value) ? value : 'balanced';
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
