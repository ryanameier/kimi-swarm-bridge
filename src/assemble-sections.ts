#!/usr/bin/env node
/**
 * kimi-assemble: joins AgentSwarm section files into one document without a model.
 *
 *   kimi-assemble <output.md> [sections-dir]
 *
 * sections-dir (default: .sections next to the output) holds:
 *   _head.md         title, intro and the summary-table header (written by the coordinator)
 *   <NN>-<topic>.md  one per worker: its summary-table rows, then its detail sections
 *   _tail.md         recommendations and anything else that goes last
 *
 * Table rows are the `|` lines before a file's first heading (or, failing that, its first
 * `|` block). They go into one contiguous table in file-name order, with blank lines and
 * repeated header/separator lines dropped. The directory is deleted afterwards.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isRow = (line: string) => line.trimStart().startsWith('|');
const isSeparator = (line: string) => /^\s*\|[\s:|-]*-{3,}[\s:|-]*$/.test(line);

export function splitSection(text: string): { rows: string[]; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  const before = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  let rowIndexes = before.flatMap((line, index) => (isRow(line) ? [index] : []));
  if (rowIndexes.length === 0) {
    // Rows placed elsewhere: take the first contiguous block of table lines.
    const start = lines.findIndex(isRow);
    if (start !== -1) {
      let end = start;
      while (end + 1 < lines.length && isRow(lines[end + 1]!)) end += 1;
      rowIndexes = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
  }
  const taken = new Set(rowIndexes);
  const rows = rowIndexes.map((i) => lines[i]!.trim()).filter((line) => !isSeparator(line));
  const body = lines.filter((_, index) => !taken.has(index)).join('\n').trim();
  return { rows, body };
}

export function assembleSections(dir: string): { text: string; files: number; rows: number } {
  const names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  const read = (name: string) => (names.includes(name) ? readFileSync(join(dir, name), 'utf8').trim() : '');
  const head = read('_head.md');
  const tail = read('_tail.md');
  const headerLines = new Set(head.split('\n').filter(isRow).map((line) => line.trim()));
  const parts = names.filter((name) => !name.startsWith('_')).map((name) => splitSection(readFileSync(join(dir, name), 'utf8')));
  const rows = parts.flatMap((part) => part.rows).filter((row) => !headerLines.has(row));
  const table = [head, rows.join('\n')].filter(Boolean).join('\n');
  const blocks = [table, ...parts.map((part) => part.body), tail].filter(Boolean);
  return { text: `${blocks.join('\n\n')}\n`, files: parts.length, rows: rows.length };
}

function main(argv: string[]): number {
  const [output, sectionsArg] = argv;
  if (!output) {
    console.error('Usage: kimi-assemble <output.md> [sections-dir]');
    return 2;
  }
  const dir = sectionsArg ?? join(dirname(output), '.sections');
  if (!existsSync(dir)) {
    console.error(`No sections directory at ${dir}`);
    return 1;
  }
  const { text, files, rows } = assembleSections(dir);
  writeFileSync(output, text);
  rmSync(dir, { recursive: true, force: true });
  console.log(`Wrote ${output}: ${files} section files, ${rows} table rows. Removed ${dir}.`);
  return 0;
}

if (process.argv[1] && /^assemble-sections\.[jt]s$/.test(basename(process.argv[1])) && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
