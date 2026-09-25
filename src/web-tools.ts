import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Web research tools for Kimi workers (stdio MCP server registered in Kimi's
 * mcp.json by the supervisor).
 *
 * - web_search: Brave Search API; returns titles, URLs and snippets.
 * - read_page: fetches a page and has a small, fast ai& model extract only what
 *   the worker asked for, so full pages never enter the worker's context
 *   (the main source of slow steps and token use in research swarms). Pages
 *   that need JavaScript fall back to a headless browser when available
 *   (Cloudflare Browser Rendering through http://browser.internal).
 *
 * Tool definitions are deliberately short: they are re-sent on every step.
 */

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const BROWSER_URL = 'http://browser.internal/render';
const DEFAULT_READER_MODEL = 'deepseek-ai/deepseek-v4-flash';
const MAX_PAGE_CHARS = 80_000;
const RAW_CHARS = 12_000;
const MIN_USEFUL_TEXT = 400;

export interface WebToolsEnv {
  BRAVE_API_KEY?: string;
  KIMI_MODEL_BASE_URL?: string;
  KIMI_MODEL_API_KEY?: string;
  KIMI_READER_MODEL?: string;
  KIMI_BROWSER_RENDERING?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

type Fetch = typeof fetch;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const value = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Readable text from HTML: main/article content when present, without scripts, styles or navigation. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  let body = html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(body)?.[0];
  if (main && main.length > 2_000) body = main;
  else body = body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const text = decodeEntities(
    body
      .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n# ')
      .replace(/<(li)\b[^>]*>/gi, '\n- ')
      .replace(/<(td|th)\b[^>]*>/gi, ' | ')
      .replace(/<\/?(p|div|section|br|tr|table|ul|ol|pre|blockquote|dd|dt)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*(\n\s*)+/g, '\n\n')
    .trim();
  return { title, text };
}

export async function braveSearch(query: string, count: number, env: WebToolsEnv, fetchImpl: Fetch = fetch): Promise<SearchResult[]> {
  if (!env.BRAVE_API_KEY) throw new Error('Web search is not configured (no BRAVE_API_KEY).');
  const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${Math.min(Math.max(count, 1), 20)}&extra_snippets=true`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'x-subscription-token': env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; extra_snippets?: string[]; age?: string }> };
  };
  return (data.web?.results ?? []).map((result) => ({
    title: decodeEntities((result.title ?? '').replace(/<[^>]+>/g, '')),
    url: result.url ?? '',
    snippet: decodeEntities([result.description, ...(result.extra_snippets ?? []).slice(0, 2)].filter(Boolean).join(' … ').replace(/<[^>]+>/g, '')),
    ...(result.age ? { age: result.age } : {}),
  }));
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results.map((r, i) => `${i + 1}. ${r.title}${r.age ? ` (${r.age})` : ''}\n   ${r.url}\n   ${r.snippet}`).join('\n');
}

async function fetchDirect(url: string, fetchImpl: Fetch): Promise<{ title: string; text: string; status: number }> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; KimiSwarm/1.0; research)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const type = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (/html|xml/i.test(type) || /^\s*</.test(body)) return { ...htmlToText(body), status: response.status };
  return { title: '', text: body.trim(), status: response.status };
}

async function fetchRendered(url: string, fetchImpl: Fetch): Promise<{ title: string; text: string } | undefined> {
  try {
    const response = await fetchImpl(`${BROWSER_URL}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { title?: string; text?: string };
    return data.text ? { title: data.title ?? '', text: data.text } : undefined;
  } catch {
    return undefined;
  }
}

/** Page text, using the headless browser when the plain fetch returns too little (JavaScript-built pages). */
export async function getPageText(url: string, env: WebToolsEnv, fetchImpl: Fetch = fetch): Promise<{ title: string; text: string; source: 'direct' | 'browser' }> {
  let direct: { title: string; text: string; status: number } | undefined;
  let error: unknown;
  try {
    direct = await fetchDirect(url, fetchImpl);
  } catch (caught) {
    error = caught;
  }
  const directUsable = direct && direct.status < 400 && direct.text.length >= MIN_USEFUL_TEXT;
  if (!directUsable && env.KIMI_BROWSER_RENDERING === '1') {
    const rendered = await fetchRendered(url, fetchImpl);
    if (rendered && rendered.text.length > (direct?.text.length ?? 0)) return { ...rendered, source: 'browser' };
  }
  if (direct) {
    if (direct.status >= 400 && direct.text.length < MIN_USEFUL_TEXT) throw new Error(`HTTP ${direct.status} fetching ${url}`);
    return { title: direct.title, text: direct.text, source: 'direct' };
  }
  throw new Error(`Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
}

const READER_PROMPT = `You read one web page for a research agent. Answer the agent's question using only the page text.
- Be concise and factual; keep exact figures, prices, limits, dates and names as written.
- Use short bullet points. Include brief direct quotes for key numbers.
- If the page does not contain the answer, say "Not on this page" and mention what the page is about.`;

export async function extractWithModel(question: string, page: { title: string; text: string }, url: string, env: WebToolsEnv, fetchImpl: Fetch = fetch): Promise<string> {
  if (!env.KIMI_MODEL_BASE_URL || !env.KIMI_MODEL_API_KEY) throw new Error('No model configured for read_page.');
  const response = await fetchImpl(`${env.KIMI_MODEL_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.KIMI_MODEL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.KIMI_READER_MODEL || DEFAULT_READER_MODEL,
      max_tokens: 1_500,
      messages: [
        { role: 'system', content: READER_PROMPT },
        { role: 'user', content: `Question: ${question}\n\nURL: ${url}\nTitle: ${page.title}\n\nPage text:\n${page.text.slice(0, MAX_PAGE_CHARS)}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Reader model failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || 'Reader model returned no answer.';
}

export async function readPage(
  input: { url: string; question?: string; raw?: boolean },
  env: WebToolsEnv,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const page = await getPageText(input.url, env, fetchImpl);
  const header = `Source: ${input.url}${page.title ? ` (${page.title})` : ''}`;
  if (input.raw || !input.question) {
    const text = page.text.slice(0, RAW_CHARS);
    return `${header}\n\n${text}${page.text.length > RAW_CHARS ? `\n\n[truncated: ${page.text.length} chars total; pass a question to extract specific facts]` : ''}`;
  }
  try {
    return `${header}\n\n${await extractWithModel(input.question, page, input.url, env, fetchImpl)}`;
  } catch (error) {
    // Still useful without the reader model: return the start of the page.
    return `${header}\n[reader unavailable: ${error instanceof Error ? error.message : String(error)}]\n\n${page.text.slice(0, RAW_CHARS)}`;
  }
}

export function createWebToolsServer(env: WebToolsEnv = process.env, fetchImpl: Fetch = fetch): McpServer {
  const server = new McpServer({ name: 'web', version: '1.0.0' });
  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
  const failure = (error: unknown) => ({ ...text(error instanceof Error ? error.message : String(error)), isError: true });

  server.registerTool(
    'web_search',
    {
      description: 'Search the web. Returns titles, URLs and snippets.',
      inputSchema: {
        query: z.string().min(1),
        count: z.number().int().min(1).max(20).optional().describe('Results, default 8'),
      },
    },
    async ({ query, count }) => {
      try {
        return text(formatResults(await braveSearch(query, count ?? 8, env, fetchImpl)));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'read_page',
    {
      description: 'Read a web page. With a question, returns only the relevant facts (fast, small); without one, returns the start of the page text.',
      inputSchema: {
        url: z.string().url(),
        question: z.string().optional().describe('What to extract from the page'),
      },
    },
    async ({ url, question }) => {
      try {
        return text(await readPage({ url, question }, env, fetchImpl));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export function isDirectExecution(metaUrl: string, argvPath: string | undefined = process.argv[1]): boolean {
  if (!argvPath || basename(argvPath) !== 'web-tools.js') return false;
  try {
    return fileURLToPath(metaUrl) === argvPath || basename(fileURLToPath(metaUrl)) === basename(argvPath);
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) {
  await createWebToolsServer().connect(new StdioServerTransport());
}
