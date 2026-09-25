import type { ModelPricing } from './swarm-evidence.js';

/**
 * Price of the configured model, from the provider's OpenAI-compatible
 * `/models` listing (ai& publishes input_per_1m, output_per_1m and
 * cached_input_per_1m). Cached for an hour; any failure means "unknown".
 */

const CACHE_MS = 60 * 60 * 1000;
let cached: { at: number; key: string; pricing: Promise<ModelPricing | undefined> } | undefined;

function price(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseModelPricing(listing: unknown, model: string): ModelPricing | undefined {
  const data = (listing as { data?: unknown })?.data;
  if (!Array.isArray(data)) return undefined;
  const entry = data.find((item) => (item as { id?: unknown })?.id === model) as Record<string, unknown> | undefined;
  if (!entry) return undefined;
  const inputPer1M = price(entry.input_per_1m);
  const outputPer1M = price(entry.output_per_1m);
  if (inputPer1M === undefined || outputPer1M === undefined) return undefined;
  return { inputPer1M, outputPer1M, cachedInputPer1M: price(entry.cached_input_per_1m) ?? inputPer1M };
}

async function fetchPricing(baseUrl: string, apiKey: string, model: string): Promise<ModelPricing | undefined> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    return parseModelPricing(await response.json(), model);
  } catch {
    return undefined;
  }
}

export function getModelPricing(env: NodeJS.ProcessEnv = process.env): Promise<ModelPricing | undefined> {
  const baseUrl = env.KIMI_MODEL_BASE_URL;
  const apiKey = env.KIMI_MODEL_API_KEY;
  const model = env.KIMI_MODEL_NAME;
  if (!baseUrl || !apiKey || !model) return Promise.resolve(undefined);
  const key = `${baseUrl}|${model}`;
  if (!cached || cached.key !== key || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), key, pricing: fetchPricing(baseUrl, apiKey, model) };
  }
  return cached.pricing;
}
