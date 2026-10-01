import { describe, expect, it } from 'vitest';
import { parseModelCatalog } from '../src/model-pricing.js';
import { defaultTier, resolveTaskModels, tierModels } from '../src/model-tiers.js';

const DEFAULT = 'zai-org/glm-5.3';
const catalog = parseModelCatalog({
  data: [
    { id: DEFAULT, input_per_1m: '1', output_per_1m: '4', capabilities: ['reasoning', 'tool_calling'], reasoning_efforts: ['low', 'high', 'max'] },
    { id: 'deepseek-ai/deepseek-v4-flash', input_per_1m: '0.15', output_per_1m: '0.25', capabilities: ['reasoning', 'tool_calling'], reasoning_efforts: ['none', 'high', 'max'] },
    { id: 'moonshotai/kimi-k3', input_per_1m: '3', output_per_1m: '12.5', capabilities: ['reasoning', 'tool_calling'], reasoning_efforts: ['low', 'high', 'max'] },
  ],
});

describe('model tiers', () => {
  it('uses the deployment model for balanced, so nothing is rewritten', () => {
    const task = resolveTaskModels({ saved: {}, requestedTier: 'balanced', defaultModel: DEFAULT, selectable: catalog, env: {} });
    expect(task).toMatchObject({ source: 'auto', tier: 'balanced', coordinatorModel: DEFAULT, workerModel: DEFAULT, settings: {} });
  });

  it('puts economy workers on a low-cost model and keeps the coordinator', () => {
    const task = resolveTaskModels({ saved: {}, requestedTier: 'economy', defaultModel: DEFAULT, selectable: catalog, env: {} });
    expect(task.settings).toEqual({ workerModel: 'deepseek-ai/deepseek-v4-flash' });
    expect(task.coordinatorModel).toBe(DEFAULT);
  });

  it('keeps the deployment models for premium by default (premium means deep research)', () => {
    const task = resolveTaskModels({ saved: {}, requestedTier: 'premium', defaultModel: DEFAULT, selectable: catalog, env: {} });
    expect(task.settings).toEqual({});
  });

  it('pins workers to the deployment model when an admin sets a stronger premium coordinator', () => {
    const env = { KIMI_MODEL_TIERS: '{"premium":{"coordinator":"moonshotai/kimi-k3"}}' };
    const task = resolveTaskModels({ saved: {}, requestedTier: 'premium', defaultModel: DEFAULT, selectable: catalog, env });
    expect(task.settings).toEqual({ coordinatorModel: 'moonshotai/kimi-k3', workerModel: DEFAULT });
  });

  it('lets the user\'s fixed models win over the tier', () => {
    const task = resolveTaskModels({ saved: { workerModel: 'moonshotai/kimi-k3' }, requestedTier: 'economy', defaultModel: DEFAULT, selectable: catalog, env: {} });
    expect(task).toMatchObject({ source: 'user', coordinatorModel: DEFAULT, workerModel: 'moonshotai/kimi-k3' });
    expect(task.tier).toBeUndefined();
    expect(task.notes[0]).toContain('economy');
  });

  it('falls back to the deployment model when a tier model is not available', () => {
    const task = resolveTaskModels({ saved: {}, requestedTier: 'economy', defaultModel: DEFAULT, selectable: catalog.slice(0, 1), env: {} });
    expect(task.settings).toEqual({});
    expect(task.notes[0]).toContain('not available');
  });

  it('reads admin overrides and the default tier from the environment', () => {
    const env = { KIMI_MODEL_TIERS: '{"economy":{"workers":"openai/gpt-oss-120b"},"balanced":{"coordinator":null},"bogus":{}}', KIMI_DEFAULT_MODEL_TIER: 'economy' };
    expect(tierModels(env)).toEqual({ economy: { workers: 'openai/gpt-oss-120b' }, balanced: {}, premium: {} });
    expect(defaultTier(env)).toBe('economy');
    expect(defaultTier({ KIMI_DEFAULT_MODEL_TIER: 'cheap' })).toBe('balanced');
    expect(tierModels({ KIMI_MODEL_TIERS: 'not json' }).economy).toEqual({ workers: 'deepseek-ai/deepseek-v4-flash' });
  });

  it('uses the default tier when the caller names none', () => {
    const task = resolveTaskModels({ saved: {}, defaultModel: DEFAULT, selectable: catalog, env: { KIMI_DEFAULT_MODEL_TIER: 'economy' } });
    expect(task.tier).toBe('economy');
  });
});
