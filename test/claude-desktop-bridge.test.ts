import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Claude Desktop bridge and handoff swarm-evidence wiring', () => {
  it('refreshes structured swarm evidence on external kimi_get_handoff calls', () => {
    const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8');

    expect(source).toContain('async function getHandoffWithSwarmEvidence');
    expect(source).toContain('const swarmEvidence = await readSwarmEvidence({');
    expect(source).toContain('sessionId: input.sessionId');
    expect(source).toContain(
      'kimi_get_handoff: withPreflight(deps.preflight, getHandoffWithSwarmEvidence)',
    );
  });

  it('documents timeout recovery in the MCP tool description', () => {
    const catalog = readFileSync(new URL('../src/tool-catalog.ts', import.meta.url), 'utf8');

    expect(catalog).toContain('fresh structured swarmEvidence snapshot');
    expect(catalog).toContain('first call kimi_wait_until_idle on the same session');
    expect(catalog).toContain('without submitting another prompt');
  });

  it('ships a stdio to Streamable HTTP bridge for Claude Desktop', () => {
    const bridge = readFileSync(
      new URL('../scripts/claude-desktop/kimi-mcp-bridge.py', import.meta.url),
      'utf8',
    );
    const launcher = readFileSync(
      new URL('../scripts/claude-desktop/kimi-mcp-desktop.sh', import.meta.url),
      'utf8',
    );

    expect(bridge).toContain('Mcp-Session-Id');
    expect(bridge).toContain('application/json, text/event-stream');
    expect(bridge).toContain('MCP-Protocol-Version');
    expect(bridge).toContain('parse_sse');
    expect(launcher).toContain('security find-generic-password');
    expect(launcher).toContain('kimi-swarm-glama');
  });
});
