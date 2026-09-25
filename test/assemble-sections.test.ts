import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleSections, splitSection } from '../src/assemble-sections.js';

function sections(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'assemble-'));
  const dir = join(root, '.sections');
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('splitSection', () => {
  it('takes the rows before the first heading and keeps the rest as the body', () => {
    const { rows, body } = splitSection('| A | 1 |\n\n| B | 2 |\n\n### A\n- detail\n');
    expect(rows).toEqual(['| A | 1 |', '| B | 2 |']);
    expect(body).toBe('### A\n- detail');
  });

  it('finds rows placed after the sections and drops separator lines', () => {
    const { rows, body } = splitSection('### C\n- detail\n\n|---|---|\n| C | 3 |\n');
    expect(rows).toEqual(['| C | 3 |']);
    expect(body).toBe('### C\n- detail');
  });
});

describe('assembleSections', () => {
  it('builds one contiguous table in file order, then the bodies, then the tail', () => {
    const dir = sections({
      '_head.md': '# Report\n\nIntro.\n\n| Name | Value |\n|---|---|\n',
      '02-b.md': '| B | 2 |\n\n### B\nB details\n',
      '01-a.md': '| Name | Value |\n|---|---|\n| A | 1 |\n\n### A\nA details\n',
      '_tail.md': '## Recommendations\nPick A.\n',
    });
    const { text, files, rows } = assembleSections(dir);
    expect(files).toBe(2);
    expect(rows).toBe(2);
    expect(text).toBe('# Report\n\nIntro.\n\n| Name | Value |\n|---|---|\n| A | 1 |\n| B | 2 |\n\n### A\nA details\n\n### B\nB details\n\n## Recommendations\nPick A.\n');
  });

  it('runs as the kimi-assemble command and removes the sections directory', () => {
    const dir = sections({ '_head.md': '| N |\n|---|', '01-a.md': '| A |\n\n### A\nx' });
    const out = join(dir, '..', 'report.md');
    execFileSync('node', ['--import', 'tsx', 'src/assemble-sections.ts', out], { cwd: process.cwd() });
    expect(readFileSync(out, 'utf8')).toBe('| N |\n|---|\n| A |\n\n### A\nx\n');
    expect(existsSync(dir)).toBe(false);
  });
});
