import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseModelCatalog } from '../src/model-pricing.js';
import {
  coordinatorAlias,
  effortFor,
  loadModelSettings,
  renderKimiModelConfig,
  saveModelSettings,
  selectableModels,
  writeKimiModelConfig,
} from '../src/model-settings.js';

const catalog = parseModelCatalog({
  data: [
    { id: 'moonshotai/kimi-k3', input_per_1m: '3', output_per_1m: '12.5', cached_input_per_1m: '0.5', context_window: 1048576, capabilities: ['reasoning', 'tool_calling', 'vision'], reasoning_efforts: ['low', 'high', 'max'], reasoning_effort_default: 'max' },
    { id: 'zai-org/glm-5.3', input_per_1m: '1', output_per_1m: '4', cached_input_per_1m: '0.3', context_window: 1048576, capabilities: ['reasoning', 'tool_calling'], reasoning_efforts: ['low', 'high', 'max'], reasoning_effort_default: 'max' },
    { id: 'qwen/qwen3.8-27b', input_per_1m: '0.4', output_per_1m: '3', context_window: 131072, capabilities: ['reasoning', 'tool_calling'], reasoning_efforts: ['none', 'medium', 'xhigh'], reasoning_effort_default: 'medium' },
    { id: 'embed/no-tools', capabilities: [] },
  ],
});

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-models-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('model settings', () => {
  it('offers only tool-calling models, optionally narrowed by the admin', () => {
    expect(selectableModels(catalog, {}).map((m) => m.id)).toEqual(['moonshotai/kimi-k3', 'zai-org/glm-5.3', 'qwen/qwen3.8-27b']);
    expect(selectableModels(catalog, { KIMI_ALLOWED_MODELS: 'zai-org/glm-5.3, embed/no-tools' }).map((m) => m.id)).toEqual(['zai-org/glm-5.3']);
  });

  it('picks a supported reasoning effort', () => {
    expect(effortFor(catalog[1], 'high')).toBe('high');
    expect(effortFor(catalog[2], 'high')).toBe('medium');
  });

  it('renders worker models as a forced secondary model on the environment provider', () => {
    const toml = renderKimiModelConfig({ workerModel: 'zai-org/glm-5.3' }, catalog, 'moonshotai/kimi-k3', 'high');
    expect(toml).toContain('[models."aiand:zai-org/glm-5.3"]\nprovider = "__kimi_env__"\nmodel = "zai-org/glm-5.3"\nmax_context_size = 131072\ncapabilities = ["thinking"]');
    expect(toml).toContain('[secondary_model]\nforce = true\ndefault_model = "aiand:zai-org/glm-5.3"\ndefault_effort = "high"');
    expect(toml).not.toContain('api_key');
  });

  it('uses the environment model alias for the deployment default and no section when nothing is chosen', () => {
    const toml = renderKimiModelConfig({ coordinatorModel: 'zai-org/glm-5.3', workerModel: 'moonshotai/kimi-k3' }, catalog, 'moonshotai/kimi-k3', 'high');
    expect(toml).toContain('default_model = "__kimi_env_model__"');
    expect(toml).not.toContain('[models."aiand:moonshotai/kimi-k3"]');
    expect(renderKimiModelConfig({}, catalog, 'moonshotai/kimi-k3', 'high')).not.toContain('[secondary_model]');
    expect(coordinatorAlias({ coordinatorModel: 'zai-org/glm-5.3' }, 'moonshotai/kimi-k3')).toBe('aiand:zai-org/glm-5.3');
    expect(coordinatorAlias({}, 'moonshotai/kimi-k3')).toBeUndefined();
  });

  it('persists settings and never overwrites a config.toml it did not write', () => {
    const state = tempDir();
    saveModelSettings(state, { workerModel: 'zai-org/glm-5.3' });
    expect(loadModelSettings(state)).toEqual({ workerModel: 'zai-org/glm-5.3' });

    const home = tempDir();
    const toml = renderKimiModelConfig({ workerModel: 'zai-org/glm-5.3' }, catalog, 'moonshotai/kimi-k3', 'high');
    writeKimiModelConfig(home, toml);
    writeKimiModelConfig(home, toml);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(toml);

    const custom = tempDir();
    writeFileSync(join(custom, 'config.toml'), 'default_model = "mine"\n');
    expect(() => writeKimiModelConfig(custom, toml)).toThrow('not written by kimi-swarm-bridge');
  });
});
