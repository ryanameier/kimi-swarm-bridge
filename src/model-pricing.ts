import type { ModelPricing } from './swarm-evidence.js';

/**
 * The provider's model catalog from its OpenAI-compatible `/models` listing.
 * ai& publishes prices (input_per_1m, output_per_1m, cached_input_per_1m),
 * context windows, capabilities and reasoning efforts. Cached for an hour;
 * any failure means "unknown".
 */

export interface CatalogModel {
  id: string;
  pricing?: ModelPricing;
  contextWindow?: number;
  capabilities: string[];
  reasoningEfforts: string[];
  defaultEffort?: string;
  description?: string;
}

const CACHE_MS = 60 * 60 * 1000;
let cached: { at: number; key: string; catalog: Promise<CatalogModel[] | undefined> } | undefined;

function price(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseModelCatalog(listing: unknown): CatalogModel[] {
  const data = (listing as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: CatalogModel[] = [];
  for (const item of data) {
    const entry = item as Record<string, unknown>;
    if (typeof entry?.id !== 'string') continue;
    const inputPer1M = price(entry.input_per_1m);
    const outputPer1M = price(entry.output_per_1m);
    models.push({
      id: entry.id,
      ...(inputPer1M !== undefined && outputPer1M !== undefined
        ? { pricing: { inputPer1M, outputPer1M, cachedInputPer1M: price(entry.cached_input_per_1m) ?? inputPer1M } }
        : {}),
      ...(typeof entry.context_window === 'number' ? { contextWindow: entry.context_window } : {}),
      capabilities: strings(entry.capabilities),
      reasoningEfforts: strings(entry.reasoning_efforts),
      ...(typeof entry.reasoning_effort_default === 'string' ? { defaultEffort: entry.reasoning_effort_default } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    });
  }
  return models;
}

export function parseModelPricing(listing: unknown, model: string): ModelPricing | undefined {
  return parseModelCatalog(listing).find((entry) => entry.id === model)?.pricing;
}

async function fetchCatalog(baseUrl: string, apiKey: string): Promise<CatalogModel[] | undefined> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const catalog = parseModelCatalog(await response.json());
    return catalog.length > 0 ? catalog : undefined;
  } catch {
    return undefined;
  }
}

export function getModelCatalog(env: NodeJS.ProcessEnv = process.env): Promise<CatalogModel[] | undefined> {
  const baseUrl = env.KIMI_MODEL_BASE_URL;
  const apiKey = env.KIMI_MODEL_API_KEY;
  if (!baseUrl || !apiKey) return Promise.resolve(undefined);
  if (!cached || cached.key !== baseUrl || Date.now() - cached.at > CACHE_MS) {
    const catalog = fetchCatalog(baseUrl, apiKey);
    cached = { at: Date.now(), key: baseUrl, catalog };
    // Do not keep a failed lookup for an hour.
    void catalog.then((result) => {
      if (result === undefined && cached?.catalog === catalog) cached = undefined;
    });
  }
  return cached.catalog;
}

/** Price of one model (defaults to the configured KIMI_MODEL_NAME). */
export async function getModelPricing(
  env: NodeJS.ProcessEnv = process.env,
  model: string | undefined = env.KIMI_MODEL_NAME,
): Promise<ModelPricing | undefined> {
  if (!model) return undefined;
  return (await getModelCatalog(env))?.find((entry) => entry.id === model)?.pricing;
}
