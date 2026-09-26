import { describe, expect, it, vi } from 'vitest';
import { braveSearch, budgetNotice, formatResults, getPageText, htmlToText, readPage, settleWithGrace, WorkerClock } from '../src/web-tools.js';

const longText = 'Pricing details. '.repeat(60);
const html = `<html><head><title>Fly Pricing &amp; Plans</title><script>var x=1</script><style>.a{}</style></head>
<body><nav>Home | Docs</nav><main><h1>Pricing</h1><p>${longText}</p><ul><li>shared-cpu-1x: $1.94/mo</li></ul><table><tr><td>A</td><td>B</td></tr></table></main><footer>© Fly</footer></body></html>`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('htmlToText', () => {
  it('keeps main content and drops scripts, styles and navigation', () => {
    const { title, text } = htmlToText(html);
    expect(title).toBe('Fly Pricing & Plans');
    expect(text).toContain('# Pricing');
    expect(text).toContain('- shared-cpu-1x: $1.94/mo');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('Home | Docs');
    expect(text).not.toContain('© Fly');
  });
});

describe('web_search', () => {
  it('queries Brave with the subscription token and formats results', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('q=mcp%20hosting');
      expect((init?.headers as Record<string, string>)['x-subscription-token']).toBe('key');
      return jsonResponse({ web: { results: [{ title: '<strong>MCP</strong> hosting', url: 'https://a.example', description: 'Deploy &amp; run', extra_snippets: ['More'], age: '2 days ago' }] } });
    });
    const results = await braveSearch('mcp hosting', 5, { BRAVE_API_KEY: 'key' }, fetchMock as unknown as typeof fetch);
    expect(formatResults(results)).toBe('1. MCP hosting (2 days ago)\n   https://a.example\n   Deploy & run … More');
  });

  it('explains a missing key', async () => {
    await expect(braveSearch('x', 5, {})).rejects.toThrow('BRAVE_API_KEY');
  });
});

describe('read_page', () => {
  const env = { KIMI_MODEL_BASE_URL: 'https://api.aiand.com/v1', KIMI_MODEL_API_KEY: 'k', KIMI_BROWSER_RENDERING: '1' };

  it('returns only the facts the reader model extracts', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://fly.io/pricing') return new Response(html, { headers: { 'content-type': 'text/html' } });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('deepseek-ai/deepseek-v4-flash');
      expect(body.messages[1].content).toContain('Question: price of shared-cpu-1x?');
      return jsonResponse({ choices: [{ message: { content: '- shared-cpu-1x: $1.94/mo' } }] });
    });
    const out = await readPage({ url: 'https://fly.io/pricing', question: 'price of shared-cpu-1x?' }, env, fetchMock as unknown as typeof fetch);
    expect(out).toBe('Source: https://fly.io/pricing (Fly Pricing & Plans)\n\n- shared-cpu-1x: $1.94/mo');
  });

  it('falls back to the headless browser for JavaScript-built pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('http://browser.internal/render')) return jsonResponse({ title: 'App', text: longText });
      return new Response('<html><body><div id="root"></div></body></html>', { headers: { 'content-type': 'text/html' } });
    });
    const page = await getPageText('https://spa.example', env, fetchMock as unknown as typeof fetch);
    expect(page.source).toBe('browser');
    expect(page.text).toBe(longText);
  });

  it('returns truncated raw text without a question, and page text when the reader fails', async () => {
    const big = `<html><body><main>${'x'.repeat(30_000)}</main></body></html>`;
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('chat/completions') ? new Response('nope', { status: 500 }) : new Response(big, { headers: { 'content-type': 'text/html' } }));
    const raw = await readPage({ url: 'https://a.example' }, env, fetchMock as unknown as typeof fetch);
    expect(raw).toContain('[truncated: 30000 chars total');
    const degraded = await readPage({ url: 'https://a.example', question: 'q' }, env, fetchMock as unknown as typeof fetch);
    expect(degraded).toContain('[reader unavailable: Reader model failed: HTTP 500');
  });
});

describe('batched tools', () => {
  it('runs several searches and page reads in one call', async () => {
    const { createWebToolsServer } = await import('../src/web-tools.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.search.brave.com')) {
        const q = new URL(url).searchParams.get('q');
        return jsonResponse({ web: { results: [{ title: `T ${q}`, url: `https://${q}.example`, description: 'd' }] } });
      }
      if (url.includes('chat/completions')) return jsonResponse({ choices: [{ message: { content: 'fact' } }] });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    });
    const server = createWebToolsServer({ BRAVE_API_KEY: 'k', KIMI_MODEL_BASE_URL: 'https://api.aiand.com/v1', KIMI_MODEL_API_KEY: 'k' }, fetchMock as unknown as typeof fetch);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const search = await client.callTool({ name: 'web_search', arguments: { queries: ['alpha', 'beta'] } });
    const searchText = (search.content as Array<{ text: string }>)[0].text;
    expect(searchText).toContain('## alpha');
    expect(searchText).toContain('https://beta.example');
    const read = await client.callTool({ name: 'read_page', arguments: { pages: [{ url: 'https://a.example', question: 'q1' }, { url: 'https://b.example', question: 'q2' }] } });
    const readText = (read.content as Array<{ text: string }>)[0].text;
    expect(readText.split('---')).toHaveLength(2);
    expect(readText).toContain('Source: https://b.example');
    await client.close();
  });
});

describe('settleWithGrace', () => {
  const after = (ms: number, value: string) => () => new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));

  it('returns every result when the batch finishes together', async () => {
    await expect(settleWithGrace([after(5, 'a'), after(10, 'b')], 1_000, () => 'late')).resolves.toEqual(['a', 'b']);
  });

  it('stops waiting for a straggler once half the batch is done and the grace period passes', async () => {
    vi.useFakeTimers();
    try {
      const pending = settleWithGrace([after(10, 'a'), after(20, 'b'), after(60_000, 'slow')], 100, (i) => `late ${i}`);
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toEqual(['a', 'b', 'late 2']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkerClock', () => {
  it('times each worker label separately and moves from ok to soft to hard', () => {
    let now = 0;
    const clock = new WorkerClock(120_000, 180_000, () => now);
    expect(clock.check('Azure AI').state).toBe('ok');
    now = 30_000;
    expect(clock.check('Groq').state).toBe('ok');
    now = 125_000;
    expect(clock.check('azure ai')).toEqual({ state: 'soft', elapsedS: 125 });
    expect(clock.check('Groq').state).toBe('ok');
    now = 185_000;
    expect(clock.check('Azure AI').state).toBe('hard');
  });

  it('ignores calls without a label and restarts a label idle for 10 minutes', () => {
    let now = 0;
    const clock = new WorkerClock(1_000, 2_000, () => now);
    expect(clock.check(undefined)).toEqual({ state: 'ok', elapsedS: 0 });
    clock.check('OpenAI');
    now = 11 * 60_000;
    expect(clock.check('OpenAI').state).toBe('ok');
  });

  it('can be turned off and reads its budgets from the environment', () => {
    let now = 0;
    const off = WorkerClock.fromEnv({ KIMI_WORKER_SOFT_BUDGET_S: '0', KIMI_WORKER_HARD_BUDGET_S: '0' });
    off.check('x');
    expect(off.check('x').state).toBe('ok');
    const custom = new WorkerClock(5_000, 0, () => now);
    custom.check('y');
    now = 60_000;
    expect(custom.check('y').state).toBe('soft');
  });

  it('tells the worker what to do at each stage', () => {
    expect(budgetNotice('soft', 130)).toContain('write your section now with what you have');
    expect(budgetNotice('hard', 190)).toContain('No new lookups were done');
  });
});

describe('web tools with a worker label', () => {
  it('refuses new lookups once a worker is past its hard budget', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createWebToolsServer } = await import('../src/web-tools.js');
    const fetchImpl = vi.fn(async () => jsonResponse({ web: { results: [{ title: 'T', url: 'https://e.com', description: 'd' }] } }));
    const server = createWebToolsServer({ BRAVE_API_KEY: 'k', KIMI_WORKER_SOFT_BUDGET_S: '0', KIMI_WORKER_HARD_BUDGET_S: '0.001' }, fetchImpl as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: 'web_search', arguments: { query: 'x', worker: 'Azure AI' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const calls = fetchImpl.mock.calls.length;
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'y', worker: 'Azure AI' } });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('Research time is up');
    expect(fetchImpl.mock.calls.length).toBe(calls);
    const unlabeled = await client.callTool({ name: 'web_search', arguments: { query: 'z' } });
    expect((unlabeled.content as Array<{ text: string }>)[0]!.text).toContain('https://e.com');
  });
});
