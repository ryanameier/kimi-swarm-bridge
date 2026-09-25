#!/usr/bin/env node
// One-command organization setup for Kimi Swarm on Cloudflare.
//
//   npm run setup                 interactive
//   npm run setup -- --dry-run    show what would happen, change nothing
//
// Re-runnable: existing KV namespaces, buckets and secrets are reused. Values can
// be supplied as environment variables instead of prompts:
//   AIAND_API_KEY, FIRECRAWL_API_KEY ("disabled" to skip web tools),
//   ACCESS_TEAM (team name or <team>.cloudflareaccess.com),
//   ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET, KIMI_WORKER_NAME,
//   KIMI_REGIONS (e.g. ENAM,WNAM; blank = anywhere), KIMI_JURISDICTION (eu | fedramp),
//   KIMI_SWARM_CONCURRENCY (workers calling ai& at once, default 4),
//   KIMI_MAX_AGENTS_CAP (highest agent ceiling users may set, default 32),
//   KIMI_DEFAULT_MAX_AGENTS (starting ceiling, default 4),
//   KIMI_DAILY_REQUEST_LIMIT (ai& model requests per employee per day, 0 = unlimited, default 3000),
//   KIMI_EGRESS_MODE (open | log | allowlist, default open), KIMI_EGRESS_ALLOWLIST (comma-separated hosts, * globs)
// Flags: --dry-run, --rotate-internal (new BRIDGE/COOKIE/ADMIN secrets), --yes (no prompts).

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(ROOT, 'wrangler.jsonc');
const DEPLOY_CONFIG = join(ROOT, 'wrangler.deploy.jsonc');
const KV_TITLE = 'OAUTH_KV';
const INTERNAL_SECRETS = ['BRIDGE_TOKEN', 'COOKIE_ENCRYPTION_KEY', 'ADMIN_TOKEN'];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const ROTATE = args.has('--rotate-internal');
const NO_PROMPT = args.has('--yes') || !process.stdin.isTTY;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n${bold(`[${n}]`)} ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);
const plan = (s) => console.log(`  ${DRY_RUN ? '· would' : '→'} ${s}`);

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function wrangler(argv, { input, json = false, allowFail = false } = {}) {
  const run = () => spawnSync('npx', ['wrangler', ...argv], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let result = run();
  // Wrangler occasionally reports an auth error while refreshing its OAuth token; retry once.
  if (result.status !== 0 && /Authentication error/.test(result.stderr + result.stdout)) {
    execFileSync('sleep', ['2']);
    result = run();
  }
  if (result.status !== 0 && !allowFail) {
    fail(`wrangler ${argv.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
  }
  if (!json) return result.stdout;
  const start = result.stdout.search(/[[{]/);
  return start >= 0 ? JSON.parse(result.stdout.slice(start)) : null;
}

async function cloudflareApi(path) {
  const token = wrangler(['auth', 'token']).trim().split('\n').pop();
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!body.success) fail(`Cloudflare API ${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

const rl = NO_PROMPT ? null : createInterface({ input: process.stdin, output: process.stdout });

async function ask(question, { secret = false, fallback } = {}) {
  if (!rl) return fallback ?? '';
  if (!secret) {
    return new Promise((resolve) => rl.question(`  ${question}${fallback ? dim(` [${fallback}]`) : ''}: `, (a) => resolve(a.trim() || fallback || '')));
  }
  // Hidden input: nothing is echoed.
  return new Promise((resolve) => {
    process.stdout.write(`  ${question}: `);
    const muted = rl._writeToOutput;
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl._writeToOutput = muted;
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function readJsonc(path) {
  const text = readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

async function main() {
  console.log(bold('Kimi Swarm — Cloudflare setup') + (DRY_RUN ? dim('  (dry run: nothing will change)') : ''));

  // 1. Prerequisites
  step(1, 'Checking prerequisites');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) fail(`Node 22+ is required (found ${process.versions.node}).`);
  ok(`Node ${process.versions.node}`);

  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    ok('Docker is running (needed to build the container image)');
  } catch {
    fail('Docker is not running. Start Docker Desktop (or the Docker daemon) and re-run.');
  }

  const who = wrangler(['whoami', '--json'], { json: true, allowFail: true });
  if (!who?.loggedIn) fail('Wrangler is not logged in. Run: npx wrangler login');
  const account = who.accounts?.length === 1
    ? who.accounts[0]
    : who.accounts?.find((a) => a.id === process.env.CLOUDFLARE_ACCOUNT_ID);
  if (!account) fail('Several Cloudflare accounts found; set CLOUDFLARE_ACCOUNT_ID to choose one.');
  ok(`Cloudflare account ${account.name} (${account.id})`);

  const subdomain = (await cloudflareApi(`/accounts/${account.id}/workers/subdomain`)).subdomain;
  if (!subdomain) fail('This account has no workers.dev subdomain yet. Open Workers & Pages in the dashboard once to create one.');

  const template = readJsonc(TEMPLATE);
  const workerName = process.env.KIMI_WORKER_NAME || await ask('Worker name', { fallback: template.name });
  const origin = `https://${workerName}.${subdomain}.workers.dev`;
  ok(`Worker URL will be ${origin}`);

  // 2. Storage
  step(2, 'Sign-in storage and backup bucket');
  const namespaces = wrangler(['kv', 'namespace', 'list'], { json: true }) ?? [];
  // Each deployment gets its own storage; the default worker name keeps the original names.
  const isDefault = workerName === template.name;
  const kvTitle = `${workerName}-${KV_TITLE}`;
  let kv = namespaces.find((n) => n.title === kvTitle) ?? (isDefault ? namespaces.find((n) => n.title === KV_TITLE) : undefined);
  if (kv) {
    ok(`KV namespace ${kv.title} exists (${kv.id})`);
  } else {
    plan(`create KV namespace ${kvTitle}`);
    if (!DRY_RUN) {
      const out = wrangler(['kv', 'namespace', 'create', kvTitle]);
      const id = /"id":\s*"([0-9a-f]+)"/.exec(out)?.[1] ?? /id = "([0-9a-f]+)"/.exec(out)?.[1];
      if (!id) fail(`Could not read the new namespace id from wrangler output:\n${out}`);
      kv = { id, title: kvTitle };
      ok(`created KV namespace ${id}`);
    }
  }

  const templateBucket = template.r2_buckets?.[0]?.bucket_name ?? 'kimi-swarm-backups';
  const bucketName = isDefault ? templateBucket : `${workerName}-backups`;
  const buckets = (await cloudflareApi(`/accounts/${account.id}/r2/buckets`)).buckets ?? [];
  if (buckets.some((b) => b.name === bucketName)) {
    ok(`R2 bucket ${bucketName} exists`);
  } else {
    plan(`create R2 bucket ${bucketName}`);
    if (!DRY_RUN) {
      wrangler(['r2', 'bucket', 'create', bucketName]);
      ok(`created R2 bucket ${bucketName}`);
    }
  }

  // 3. Deploy config (account-specific, git-ignored)
  step(3, 'Writing wrangler.deploy.jsonc');
  const config = { ...template, name: workerName };
  config.kv_namespaces = [{ binding: 'OAUTH_KV', id: kv?.id ?? '<created on a real run>' }];
  config.r2_buckets = [{ binding: 'BACKUP_BUCKET', bucket_name: bucketName }];

  // Swarm guardrails. Concurrency bounds simultaneous ai& requests per employee;
  // agents beyond it queue. Users change their own ceiling from chat within the cap.
  const intVar = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return String(fallback);
    if (!/^[1-9][0-9]*$/.test(raw)) fail(`${name} must be a positive whole number.`);
    return raw;
  };
  const countVar = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return String(fallback);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail(`${name} must be a whole number (0 = unlimited).`);
    return raw;
  };
  const previousVars = existsSync(DEPLOY_CONFIG) ? readJsonc(DEPLOY_CONFIG).vars ?? {} : {};
  const pick = (name) => previousVars[name] ?? config.vars?.[name];
  config.vars = {
    ...config.vars,
    SWARM_CONCURRENCY: intVar('KIMI_SWARM_CONCURRENCY', pick('SWARM_CONCURRENCY') ?? 4),
    MAX_AGENTS_CAP: intVar('KIMI_MAX_AGENTS_CAP', pick('MAX_AGENTS_CAP') ?? 32),
    DEFAULT_MAX_AGENTS: intVar('KIMI_DEFAULT_MAX_AGENTS', pick('DEFAULT_MAX_AGENTS') ?? 4),
    AIAND_DAILY_REQUEST_LIMIT: countVar('KIMI_DAILY_REQUEST_LIMIT', pick('AIAND_DAILY_REQUEST_LIMIT') ?? 3000),
    EGRESS_MODE: process.env.KIMI_EGRESS_MODE?.trim().toLowerCase() || pick('EGRESS_MODE') || 'open',
    EGRESS_ALLOWLIST: process.env.KIMI_EGRESS_ALLOWLIST ?? pick('EGRESS_ALLOWLIST') ?? '',
  };
  if (!['open', 'log', 'allowlist'].includes(config.vars.EGRESS_MODE)) fail('KIMI_EGRESS_MODE must be open, log or allowlist.');
  ok(`agents per task: ${config.vars.DEFAULT_MAX_AGENTS} by default, users may raise to ${config.vars.MAX_AGENTS_CAP}; ${config.vars.SWARM_CONCURRENCY} call ai& at once per employee`);
  const limit = config.vars.AIAND_DAILY_REQUEST_LIMIT;
  ok(`ai& budget: ${limit === '0' ? 'unlimited' : `${limit} model requests per employee per day`}; outbound traffic: ${config.vars.EGRESS_MODE}${config.vars.EGRESS_MODE === 'allowlist' ? ` (${config.vars.EGRESS_ALLOWLIST || 'ai& and Firecrawl only'})` : ''}`);

  // Where employee containers may run (data residency / latency).
  const REGIONS = ['ENAM', 'WNAM', 'EEUR', 'WEUR', 'APAC', 'SAM', 'ME', 'OC', 'AFR'];
  // Re-runs keep the previous placement unless told otherwise.
  const previous = existsSync(DEPLOY_CONFIG) ? readJsonc(DEPLOY_CONFIG).containers?.[0]?.constraints ?? {} : {};
  const previousRegions = (previous.regions ?? []).join(',');
  const regions = (process.env.KIMI_REGIONS ?? await ask(`Container regions, comma-separated (${REGIONS.join(' ')}; Enter = anywhere)`, { fallback: previousRegions || undefined }) ?? previousRegions)
    .split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  const unknown = regions.filter((r) => !REGIONS.includes(r));
  if (unknown.length) fail(`Unknown region(s): ${unknown.join(', ')}. Use: ${REGIONS.join(', ')}.`);
  const jurisdiction = (process.env.KIMI_JURISDICTION ?? previous.jurisdiction ?? '').trim().toLowerCase();
  if (jurisdiction && !['eu', 'fedramp'].includes(jurisdiction)) fail('KIMI_JURISDICTION must be eu or fedramp.');
  if (regions.length || jurisdiction) {
    config.containers = config.containers.map((c) => ({
      ...c,
      constraints: { ...(regions.length ? { regions } : {}), ...(jurisdiction ? { jurisdiction } : {}) },
    }));
    ok(`containers limited to ${[regions.join('/'), jurisdiction && `jurisdiction ${jurisdiction}`].filter(Boolean).join(', ')}`);
  } else {
    ok('containers may run in any region');
  }
  plan(`write ${DEPLOY_CONFIG}`);
  if (!DRY_RUN) {
    writeFileSync(DEPLOY_CONFIG, `// Generated by npm run setup. Account-specific; do not commit.\n${JSON.stringify(config, null, '\t')}\n`);
    ok('written');
  }

  // 4. Cloudflare Access (the sign-in app employees use)
  step(4, 'Employee sign-in (Cloudflare Access)');
  const existing = new Set(
    (wrangler(['secret', 'list', '--name', workerName, '--format', 'json'], { json: true, allowFail: true }) ?? []).map((s) => s.name),
  );
  const haveAccess = ['ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET', 'ACCESS_AUTHORIZATION_URL', 'ACCESS_TOKEN_URL', 'ACCESS_JWKS_URL']
    .every((name) => existing.has(name));
  const secrets = {};

  if (haveAccess && !process.env.ACCESS_CLIENT_ID) {
    ok('Access sign-in is already configured (re-run with ACCESS_* variables to change it)');
  } else {
    console.log(`
  In the Cloudflare dashboard: ${bold('Zero Trust → Access controls → Applications → Create new application → SaaS applications')}
    Application:        Kimi Swarm (custom)
    Protocol:           OIDC
    Redirect URL:       ${bold(`${origin}/callback`)}
    Scopes:             openid, email, profile
    Grant type:         Authorization code with PKCE
    Login method:       your identity provider (Google Workspace, Okta, Entra…) or One-time PIN
    Policy:             Allow → the employees or groups who should get Kimi Swarm
  Save it, then copy the values it shows.`);
    const team = (process.env.ACCESS_TEAM || await ask('Zero Trust team name (the part before .cloudflareaccess.com)'))
      .replace(/^https?:\/\//, '').replace(/\.cloudflareaccess\.com.*$/, '');
    const clientId = process.env.ACCESS_CLIENT_ID || await ask('Client ID');
    const clientSecret = process.env.ACCESS_CLIENT_SECRET || await ask('Client secret', { secret: true });
    if (!team || !clientId || !clientSecret) fail('Team name, client ID and client secret are all required.');
    const base = `https://${team}.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${clientId}`;
    const jwks = await fetch(`${base}/jwks`);
    if (!jwks.ok) fail(`${base}/jwks returned HTTP ${jwks.status}; check the team name and client ID.`);
    ok('Access app found');
    Object.assign(secrets, {
      ACCESS_CLIENT_ID: clientId,
      ACCESS_CLIENT_SECRET: clientSecret,
      ACCESS_AUTHORIZATION_URL: `${base}/authorization`,
      ACCESS_TOKEN_URL: `${base}/token`,
      ACCESS_JWKS_URL: `${base}/jwks`,
    });
  }

  // 5. API keys and internal secrets
  step(5, 'API keys and internal secrets');
  if (process.env.AIAND_API_KEY || !existing.has('AIAND_API_KEY')) {
    const key = process.env.AIAND_API_KEY || await ask('ai& API key', { secret: true });
    if (!key) fail('An ai& API key is required.');
    const probe = await fetch('https://api.aiand.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    if (!probe.ok) fail(`ai& rejected the key (HTTP ${probe.status}).`);
    ok('ai& key works');
    secrets.AIAND_API_KEY = key;
  } else {
    ok('ai& key already set');
  }

  if (process.env.FIRECRAWL_API_KEY || !existing.has('FIRECRAWL_API_KEY')) {
    const key = process.env.FIRECRAWL_API_KEY || await ask('Firecrawl API key (Enter to disable web tools)', { secret: true }) || 'disabled';
    if (key !== 'disabled') {
      const probe = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', { headers: { authorization: `Bearer ${key}` } });
      if (!probe.ok) fail(`Firecrawl rejected the key (HTTP ${probe.status}).`);
      ok('Firecrawl key works');
    } else {
      ok('web tools disabled (set FIRECRAWL_API_KEY later to enable)');
    }
    secrets.FIRECRAWL_API_KEY = key;
  } else {
    ok('Firecrawl key already set');
  }

  let adminToken;
  for (const name of INTERNAL_SECRETS) {
    if (ROTATE || !existing.has(name)) {
      secrets[name] = randomBytes(32).toString('hex');
      if (name === 'ADMIN_TOKEN') adminToken = secrets[name];
      plan(`${existing.has(name) ? 'rotate' : 'generate'} ${name}`);
    } else {
      ok(`${name} already set`);
    }
  }

  // 6. Upload secrets and deploy
  step(6, 'Uploading secrets and deploying');
  const names = Object.keys(secrets);
  if (names.length) {
    plan(`upload secrets: ${names.join(', ')}`);
    if (!DRY_RUN) {
      wrangler(['secret', 'bulk', '--name', workerName], { input: JSON.stringify(secrets) });
      ok(`${names.length} secret(s) stored`);
    }
  }
  plan('build the container image and deploy (first run: several minutes)');
  if (!DRY_RUN) {
    const deploy = spawnSync('npx', ['wrangler', 'deploy', '-c', DEPLOY_CONFIG], { cwd: ROOT, stdio: 'inherit' });
    if (deploy.status !== 0) {
      fail('Deploy failed. Containers need the Workers Paid plan (Workers & Pages → Plans); R2 and Zero Trust must be enabled.');
    }
    const health = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    if (!health.ok) fail(`Deployed, but ${origin} is not answering yet (HTTP ${health.status}). Try again in a minute.`);
    ok(`live at ${origin}`);
  }

  // 7. Next steps
  step(7, 'Connect Claude');
  console.log(`
  1. Claude → Settings → Connectors → Add custom connector
       URL: ${bold(`${origin}/mcp`)}
     (Team/Enterprise owners can add it once for the whole organization.)
  2. Let Claude move attachments to Kimi: Settings → Capabilities → Allow network egress →
     "Package managers only", then add ${bold(`*.${subdomain}.workers.dev`)} under Additional allowed domains.
  3. Each employee clicks Connect and signs in through Access.
  Guide: docs/cloudflare-deploy.md`);

  if (adminToken && !DRY_RUN) {
    console.log(`
  ${bold('Admin token')} (shown once — store it in your password manager):
    ${adminToken}
  Use it for ${origin}/admin/sandboxes/<id>[/backup|/restart].`);
  }
  rl?.close();
}

main().catch((error) => fail(error.stack || String(error)));
