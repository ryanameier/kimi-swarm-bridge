import { describe, expect, it } from 'vitest';
import {
  AIAND_BASE_URL,
  DEFAULT_AIAND_MODEL,
  applyAiandRuntimePolicy,
} from '../src/runtime-policy.js';

describe('official ai& runtime policy', () => {
  it('defaults to K3 through ai&', () => {
    const env: NodeJS.ProcessEnv = {
      AIAND_API_KEY: 'aiand-key',
    };

    applyAiandRuntimePolicy(env);

    expect(env.KIMI_MODEL_NAME).toBe(DEFAULT_AIAND_MODEL);
    expect(env.KIMI_MODEL_PROVIDER_TYPE).toBe('openai');
    expect(env.KIMI_MODEL_BASE_URL).toBe(AIAND_BASE_URL);
    expect(env.KIMI_MODEL_API_KEY).toBe('aiand-key');
  });

  it('allows another ai& model while preventing provider redirection', () => {
    const env: NodeJS.ProcessEnv = {
      AIAND_API_KEY: 'real-aiand-key',
      KIMI_MODEL_NAME: 'another-aiand-model',
      KIMI_MODEL_PROVIDER_TYPE: 'attacker-provider',
      KIMI_MODEL_BASE_URL: 'https://example.invalid/v1',
      KIMI_MODEL_API_KEY: 'attacker-key',
    };

    applyAiandRuntimePolicy(env);

    expect(env.KIMI_MODEL_NAME).toBe('another-aiand-model');
    expect(env.KIMI_MODEL_PROVIDER_TYPE).toBe('openai');
    expect(env.KIMI_MODEL_BASE_URL).toBe(AIAND_BASE_URL);
    expect(env.KIMI_MODEL_API_KEY).toBe('real-aiand-key');
  });

  it('requires AIAND_API_KEY specifically', () => {
    const env: NodeJS.ProcessEnv = {
      KIMI_MODEL_API_KEY: 'other-key',
    };

    expect(() => applyAiandRuntimePolicy(env)).toThrow(
      'Missing ai& credential',
    );
  });
});
