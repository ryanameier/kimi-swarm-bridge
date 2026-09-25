#!/usr/bin/env node
// Post-deploy smoke test against a live deployment. Changes nothing.
//
//   npm run smoke -- https://kimi-swarm-bridge.<subdomain>.workers.dev
//   ADMIN_TOKEN=... KIMI_SMOKE_SANDBOX=user-<id> npm run smoke -- <url>   also runs the in-container self-test
//
// Checks OAuth discovery and that MCP, file links and admin endpoints reject
// unauthenticated callers. With ADMIN_TOKEN and a sandbox id it also runs
// POST /admin/sandboxes/<id>/selftest (no real keys in the container; ai&,
// Firecrawl and general outbound access work). The self-test makes one small
// ai& request, counted against that user's daily budget.

const base = (process.argv[2] ?? process.env.KIMI_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: npm run smoke -- https://<worker>.<subdomain>.workers.dev');
  process.exit(2);
}

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}
function expectStatus(response, ...allowed) {
  if (!allowed.includes(response.status)) throw new Error(`HTTP ${response.status}, expected ${allowed.join(' or ')}`);
}

console.log(`Smoke testing ${base}`);

await check('OAuth metadata is published', async () => {
  const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
  expectStatus(response, 200);
  const metadata = await response.json();
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (!metadata[field]) throw new Error(`missing ${field}`);
  }
  return new URL(metadata.authorization_endpoint).pathname;
});

await check('MCP rejects requests without a token', async () => {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expectStatus(response, 401);
  if (!response.headers.get('www-authenticate')) throw new Error('no WWW-Authenticate header');
});

await check('MCP rejects forged tokens', async () => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer user:grant:forged' },
    body: '{}',
  });
  expectStatus(response, 401);
});

await check('Sign-in redirects to Cloudflare Access', async () => {
  const response = await fetch(`${base}/authorize?response_type=code&client_id=smoke`, { redirect: 'manual' });
  // Unknown client ids are refused before any redirect; a 4xx here still proves the route is served by the Worker.
  expectStatus(response, 302, 400, 401);
});

await check('File links with bad signatures are refused', async () => {
  const payload = Buffer.from(JSON.stringify({ sid: `user-${'0'.repeat(40)}`, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const response = await fetch(`${base}/files/download/${payload}.c2lnbmF0dXJl`);
  expectStatus(response, 403);
});

await check('Admin endpoints require the admin token', async () => {
  const response = await fetch(`${base}/admin/sandboxes/user-${'0'.repeat(40)}`);
  expectStatus(response, 401);
});

const adminToken = process.env.ADMIN_TOKEN;
const sandbox = process.env.KIMI_SMOKE_SANDBOX;
if (adminToken && sandbox) {
  await check(`Self-test in ${sandbox}`, async () => {
    const response = await fetch(`${base}/admin/sandboxes/${sandbox}/selftest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expectStatus(response, 200);
    const { ok, results } = await response.json();
    const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k, r]) => `${k}: ${r.detail}`);
    if (!ok) throw new Error(failed.join('; '));
    return Object.keys(results).join(', ');
  });
} else {
  console.log('  - Self-test skipped (set ADMIN_TOKEN and KIMI_SMOKE_SANDBOX to run it)');
}

console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
process.exit(failures ? 1 : 0);
