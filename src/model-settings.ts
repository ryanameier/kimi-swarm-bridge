import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogModel } from './model-pricing.js';

/**
 * Per-user model choice for Kimi: the coordinator (the session that plans,
 * delegates and writes the result) and the AgentSwarm workers can use
 * different ai& models. The choice is saved in the bridge state directory and
 * applied through Kimi Code's config.toml, which Kimi reloads automatically:
 *
 * - every chosen model gets a `[models."aiand:<id>"]` alias on the ai&
 *   provider Kimi already has from the environment (`__kimi_env__`), so no
 *   credentials are written to disk;
 * - workers use `[secondary_model] force = true`, which binds every subagent
 *   to the worker model;
 * - the coordinator model is passed with each prompt the bridge submits.
 */

export const ENV_MODEL_ALIAS = '__kimi_env_model__';
const ENV_PROVIDER = '__kimi_env__';
const ALIAS_PREFIX = 'aiand:';
const MANAGED_HEADER = '# Managed by kimi-swarm-bridge (kimi_model_settings). Manual edits are overwritten.';
// Smaller windows make Kimi compact long sessions sooner, which keeps per-step cost down.
// Matches the supervisor's KIMI_MODEL_MAX_CONTEXT_SIZE default for the environment model.
function maxContextTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.KIMI_MODEL_MAX_CONTEXT_SIZE ?? env.KIMI_CONTEXT_WINDOW ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 131_072;
}

export interface ModelSettings {
  /** ai& model id for the coordinator; undefined = deployment default (KIMI_MODEL_NAME). */
  coordinatorModel?: string;
  /** ai& model id for AgentSwarm workers; undefined = same as the coordinator. */
  workerModel?: string;
}

export function modelSettingsPath(stateDir: string): string {
  return join(stateDir, 'model-settings.json');
}

export function loadModelSettings(stateDir: string): ModelSettings {
  try {
    const parsed = JSON.parse(readFileSync(modelSettingsPath(stateDir), 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof parsed.coordinatorModel === 'string' ? { coordinatorModel: parsed.coordinatorModel } : {}),
      ...(typeof parsed.workerModel === 'string' ? { workerModel: parsed.workerModel } : {}),
    };
  } catch {
    return {};
  }
}

export function saveModelSettings(stateDir: string, settings: ModelSettings): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(modelSettingsPath(stateDir), `${JSON.stringify(settings, null, 2)}\n`);
}

export function modelAlias(modelId: string, defaultModel: string | undefined): string {
  return modelId === defaultModel ? ENV_MODEL_ALIAS : `${ALIAS_PREFIX}${modelId}`;
}

/** Models the deployment allows: tool-calling models, optionally narrowed by KIMI_ALLOWED_MODELS. */
export function selectableModels(catalog: CatalogModel[], env: NodeJS.ProcessEnv = process.env): CatalogModel[] {
  const allowed = (env.KIMI_ALLOWED_MODELS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return catalog.filter((model) =>
    model.capabilities.includes('tool_calling') && (allowed.length === 0 || allowed.includes(model.id)));
}

/** Pick a reasoning effort the model supports, preferring the bridge default. */
export function effortFor(model: CatalogModel | undefined, preferred: string): string | undefined {
  if (!model || model.reasoningEfforts.length === 0) return undefined;
  if (model.reasoningEfforts.includes(preferred)) return preferred;
  return model.defaultEffort ?? model.reasoningEfforts[0];
}

function kimiCapabilities(model: CatalogModel): string[] {
  const capabilities: string[] = [];
  if (model.capabilities.includes('reasoning')) capabilities.push('thinking');
  if (model.capabilities.includes('vision')) capabilities.push('image_in');
  return capabilities;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderKimiModelConfig(
  settings: ModelSettings,
  catalog: CatalogModel[],
  defaultModel: string | undefined,
  preferredEffort: string,
): string {
  const lines = [MANAGED_HEADER, ''];
  const ids = [...new Set([settings.coordinatorModel, settings.workerModel])]
    .filter((id): id is string => id !== undefined && id !== defaultModel);
  for (const id of ids) {
    const model = catalog.find((entry) => entry.id === id);
    lines.push(
      `[models.${tomlString(modelAlias(id, defaultModel))}]`,
      `provider = ${tomlString(ENV_PROVIDER)}`,
      `model = ${tomlString(id)}`,
      `max_context_size = ${Math.min(model?.contextWindow ?? maxContextTokens(), maxContextTokens())}`,
      `capabilities = [${(model ? kimiCapabilities(model) : ['thinking']).map(tomlString).join(', ')}]`,
      '',
    );
  }
  const worker = settings.workerModel ?? settings.coordinatorModel;
  if (worker !== undefined) {
    const effort = effortFor(catalog.find((entry) => entry.id === worker), preferredEffort);
    lines.push(
      '[secondary_model]',
      'force = true',
      `default_model = ${tomlString(modelAlias(worker, defaultModel))}`,
      ...(effort ? [`default_effort = ${tomlString(effort)}`] : []),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Write Kimi's config.toml for the settings. Refuses to replace a config.toml
 * the bridge did not write, so hand-made Kimi configuration is never lost.
 */
export function writeKimiModelConfig(kimiCodeHome: string, content: string): void {
  const path = join(kimiCodeHome, 'config.toml');
  if (existsSync(path) && !readFileSync(path, 'utf8').startsWith(MANAGED_HEADER)) {
    throw new Error(`${path} was not written by kimi-swarm-bridge; not replacing it.`);
  }
  mkdirSync(kimiCodeHome, { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

/** Alias for the coordinator of new prompts, or undefined to use the Kimi default. */
export function coordinatorAlias(settings: ModelSettings, defaultModel: string | undefined): string | undefined {
  return settings.coordinatorModel === undefined ? undefined : modelAlias(settings.coordinatorModel, defaultModel);
}
