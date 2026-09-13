export const AIAND_BASE_URL = 'https://api.aiand.com/v1';
export const DEFAULT_AIAND_MODEL = 'moonshotai/kimi-k3';

export function applyAiandRuntimePolicy(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const aiandApiKey = env.AIAND_API_KEY;

  if (!aiandApiKey) {
    throw new Error(
      'Missing ai& credential: set AIAND_API_KEY at runtime.',
    );
  }

  Object.assign(env, {
    KIMI_MODEL_NAME:
      env.KIMI_MODEL_NAME || DEFAULT_AIAND_MODEL,
    KIMI_MODEL_PROVIDER_TYPE: 'openai',
    KIMI_MODEL_API_KEY: aiandApiKey,
    KIMI_MODEL_BASE_URL: AIAND_BASE_URL,
  });

  return env;
}
