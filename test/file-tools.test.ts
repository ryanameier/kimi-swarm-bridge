import { describe, expect, it } from 'vitest';
import { filePanelEnabled } from '../src/file-tools.js';

describe('filePanelEnabled', () => {
  it('hides the panel from Claude clients, which move files natively', () => {
    expect(filePanelEnabled('claude-ai', {})).toBe(false);
    expect(filePanelEnabled('Claude Desktop', {})).toBe(false);
    expect(filePanelEnabled('claude-code', {})).toBe(false);
  });

  it('offers the panel to other MCP Apps hosts and unknown clients', () => {
    expect(filePanelEnabled('vscode-copilot', {})).toBe(true);
    expect(filePanelEnabled(undefined, {})).toBe(true);
  });

  it('honours KIMI_FILE_PANEL overrides', () => {
    expect(filePanelEnabled('claude-ai', { KIMI_FILE_PANEL: 'always' })).toBe(true);
    expect(filePanelEnabled('goose', { KIMI_FILE_PANEL: 'never' })).toBe(false);
  });
});
