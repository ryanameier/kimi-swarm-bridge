import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_METADATA } from '../src/tool-catalog.js';

const READ_ONLY_TOOLS = [
  'kimi_wait_until_idle',
  'kimi_get_handoff',
  'kimi_review_package',
  'kimi_get_diff',
  'kimi_bridge_status',
  'kimi_recent_sessions',
  'kimi_find_recent_session',
] as const;

const MUTATING_TOOLS = [
  'kimi_delegate_task',
  'kimi_delegate_and_wait',
  'kimi_continue_task',
  'kimi_abort',
] as const;

describe('MCP tool catalog quality metadata', () => {
  it('defines metadata for all 11 public tools', () => {
    expect(Object.keys(TOOL_METADATA).sort()).toEqual([
      'kimi_abort',
      'kimi_bridge_status',
      'kimi_continue_task',
      'kimi_delegate_and_wait',
      'kimi_delegate_task',
      'kimi_find_recent_session',
      'kimi_get_diff',
      'kimi_get_handoff',
      'kimi_recent_sessions',
      'kimi_review_package',
      'kimi_wait_until_idle',
    ]);
  });

  it('provides substantive titles, descriptions, and complete behavior annotations', () => {
    for (const metadata of Object.values(TOOL_METADATA)) {
      expect(metadata.title.length).toBeGreaterThan(5);
      expect(metadata.description.length).toBeGreaterThan(120);
      expect(metadata.annotations.readOnlyHint).toBeTypeOf('boolean');
      expect(metadata.annotations.destructiveHint).toBeTypeOf('boolean');
      expect(metadata.annotations.idempotentHint).toBeTypeOf('boolean');
    }
  });

  it('marks query/review tools read-only and task-control tools mutating', () => {
    for (const name of READ_ONLY_TOOLS) {
      expect(TOOL_METADATA[name].annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    for (const name of MUTATING_TOOLS) {
      expect(TOOL_METADATA[name].annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    }
  });

  it('describes tool parameters in the registered input schemas', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    expect((source.match(/server\.registerTool\(/g) ?? []).length).toBe(11);
    expect((source.match(/\.describe\(/g) ?? []).length).toBeGreaterThanOrEqual(30);
    expect(source).toContain('structured swarmEvidence');
    expect(source).toContain('local desktop paths are not automatically available');
  });

  it('ships Glama ownership metadata', () => {
    const glama = JSON.parse(readFileSync('glama.json', 'utf8')) as {
      $schema: string;
      maintainers: string[];
    };
    expect(glama.$schema).toBe('https://glama.ai/mcp/schemas/server.json');
    expect(glama.maintainers).toContain('ryanameier');
  });
});
