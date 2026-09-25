# Organization deployment on Cloudflare

This guide deploys Kimi Swarm for a whole organization. An admin sets it up once;
employees add nothing but a Claude connector and sign in with their work identity.

```text
Claude (web / desktop / Claude Code)
   │  remote MCP + OAuth
   ▼
Cloudflare Worker ── Cloudflare Access (your identity provider or one-time PIN)
   │  verified employee → one Sandbox per employee
   │  holds the ai& / Firecrawl keys; answers the MCP handshake itself
   ▼
Sandbox container (per employee, placeholder keys only)
   ├─ Kimi Code 0.42 + native AgentSwarm
   ├─ MCP bridge (this repo) + file transfer
   ├─ firecrawl-mcp (web search / scrape for workers)
   └─ workbench: python3, pypdf, reportlab, python-docx, openpyxl, pillow, poppler, git, zip
        │ all Kimi inference → ai& (https://api.aiand.com/v1, moonshotai/kimi-k3)
        │ outbound calls to ai& / Firecrawl pass through the Worker, which adds the key
R2: workspace and Kimi-state backups (restored automatically when a container restarts)
```

Vendors: **Cloudflare**, **ai&**, and **Firecrawl** (optional; paid plan for commercial use).

## What employees get

- Kimi tools in Claude (`kimi_delegate_task`, `kimi_wait_until_idle`, `kimi_get_handoff`, …).
- Their own isolated Linux workspace. Employees never share a filesystem or process space.
- Files in: Claude uploads chat attachments itself with `kimi_create_upload_links` from code
  execution; the server's MCP instructions tell it when and how.
- Files out: Kimi writes deliverables to `/workspace/outputs`; Claude fetches them with
  `kimi_create_download_links` and attaches them to the conversation.
- Other MCP Apps hosts (not Claude) also get `kimi_file_panel`, an in-chat upload/download
  panel. Claude's app sandbox blocks file pickers, so the panel is not offered to Claude
  clients (`KIMI_FILE_PANEL=always|never` overrides).
- Work survives restarts: `/workspace` and Kimi's state are backed up to R2 and restored.

## Prerequisites

- Cloudflare account with **Workers Paid** ($5/month; required for Containers), **R2** enabled,
  **Zero Trust** (Free plan covers 50 users), and a workers.dev subdomain (open Workers & Pages
  once to create it).
- ai& API key. Firecrawl API key (optional).
- Node 22, Docker (to build the container image), and `npx wrangler login`.

## 1. Run setup

```bash
cd cloudflare
npm install
npx wrangler login
npm run setup
```

`npm run setup` checks the prerequisites, creates this deployment's sign-in storage (KV) and
backup bucket (R2), asks where containers may run, walks you through the one dashboard step
(below), validates your ai&, Firecrawl and Access values, generates the internal secrets,
deploys (the first build takes a few minutes), confirms the Worker answers, and prints the
Claude settings. It is safe to re-run: existing resources and secrets are kept.
`npm run setup -- --dry-run` shows the plan without changing anything.

**The one dashboard step (setup prints the exact redirect URL):** Zero Trust →
**Access controls → Applications → Create new application → SaaS applications**:

| Field | Value |
|---|---|
| Application | `Kimi Swarm` (custom) |
| Authentication protocol | OIDC |
| Redirect URL | `https://<worker-name>.<your-subdomain>.workers.dev/callback` |
| Scopes | `openid`, `email`, `profile` |
| Grant type | Authorization code with PKCE |
| Login method | Your identity provider (Google Workspace, Okta, Entra, …), or One-time PIN for a pilot |
| Policy | Allow → the employees or groups who should get Kimi Swarm |

This policy is how you assign Kimi Swarm to people. Give setup the team name, client ID and
client secret it shows.

### Unattended setup

Every prompt has an environment variable: `AIAND_API_KEY`, `FIRECRAWL_API_KEY` (`disabled`
to turn off web tools), `ACCESS_TEAM`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`,
`KIMI_WORKER_NAME`, `KIMI_REGIONS` (e.g. `ENAM,WNAM`), `KIMI_JURISDICTION` (`eu` or
`fedramp`), plus the limits and policies below (`KIMI_SWARM_CONCURRENCY`,
`KIMI_MAX_AGENTS_CAP`, `KIMI_DEFAULT_MAX_AGENTS`, `KIMI_DAILY_REQUEST_LIMIT`,
`KIMI_EGRESS_MODE`, `KIMI_EGRESS_ALLOWLIST`). Re-runs keep previous values unless a variable
overrides them. Run `npm run setup -- --yes`. `--rotate-internal` replaces the generated
`BRIDGE_TOKEN`, `COOKIE_ENCRYPTION_KEY` and `ADMIN_TOKEN`.

Setup writes `wrangler.deploy.jsonc` (account-specific, git-ignored). Later deploys:
`npm run deploy`.

## 2. Add the connector in Claude

Claude → **Settings → Connectors → Add custom connector** →
`https://kimi-swarm-bridge.<your-subdomain>.workers.dev/mcp`. On Team/Enterprise an owner can
add it for the organization. Each employee clicks **Connect** and signs in once.

For attachment hand-off through code execution, allow the upload domain:
**Settings → Capabilities → Allow network egress → Package managers only** and add
`*.<your-subdomain>.workers.dev` under *Additional allowed domains* (organization settings on
Team/Enterprise). Without it, Claude cannot move attachments into the workspace; it can still
share download links.

## Agent limits and ai& rate limits

- **Agents per task (a ceiling).** Kimi decides how many AgentSwarm workers each task needs;
  the ceiling only bounds it. It starts at `DEFAULT_MAX_AGENTS` (4). Employees change their own
  ceiling from chat ("increase the Kimi agent limit to 20", via `kimi_swarm_settings`), up to
  `MAX_AGENTS_CAP` (32; Kimi's hard maximum is 128).
- **Workers calling ai& at once (a guardrail).** `SWARM_CONCURRENCY` (4) limits how many
  workers run simultaneously per employee; extra workers wait in a rolling queue and start as
  soon as a running worker finishes. A 20-agent task at concurrency 4 still runs all 20 workers,
  never more than 4 at a time, so simultaneous ai& requests stay bounded however high the
  ceiling is. Each employee's container has its own limit.
- **Rate limits.** ai& reports `X-RateLimit-Limit` (100 at the time of writing). Kimi starts
  workers in batches, retries HTTP 429 with exponential backoff, and temporarily lowers its
  concurrency when rate-limited. Size `SWARM_CONCURRENCY` × active employees to your ai& limit.
- **Daily budget per employee.** `AIAND_DAILY_REQUEST_LIMIT` (3000) caps ai& model requests
  per employee per UTC day; `0` means unlimited. The Worker counts every model call on its way
  out; over the limit, Kimi gets a quota error and reports it instead of retrying.
  `GET /admin/sandboxes/<id>` shows today's count.

Set these with `KIMI_SWARM_CONCURRENCY`, `KIMI_MAX_AGENTS_CAP`, `KIMI_DEFAULT_MAX_AGENTS` and
`KIMI_DAILY_REQUEST_LIMIT` when running `npm run setup`.

## Outbound internet access

Kimi's workers need the internet to research, download files, clone repositories and install
packages. `EGRESS_MODE` (setup: `KIMI_EGRESS_MODE`) chooses the policy:

| Mode | Behaviour |
|---|---|
| `open` (default) | Everything allowed; only ai& and Firecrawl traffic goes through the Worker. |
| `log` | Everything allowed; every outbound HTTP(S) request is logged (host, method, sandbox) to Workers Logs as `{"event":"egress",…}`. |
| `allowlist` | Only hosts matching `EGRESS_ALLOWLIST` (comma-separated, `*` globs, e.g. `*.github.com,pypi.org,files.pythonhosted.org,registry.npmjs.org`) plus ai& and Firecrawl; others get HTTP 403. |

In `log` and `allowlist` modes HTTPS is inspected with a Cloudflare-issued certificate that
the container trusts (git, curl, pip, npm, Python and Node pick it up automatically). The
policy covers HTTP and HTTPS; other protocols (for example SSH to git hosts) are not
filtered. Changing modes takes effect for each container when it next starts.

## Limits

| Layer | Limit |
|---|---|
| Claude chat attachment | 30 MB per file (Claude) |
| Upload link (this bridge) | 100 MB per file by default (`KIMI_MAX_UPLOAD_BYTES`); single use; 15 min |
| Download link | 1 hour, reusable until expiry |
| Worker request body | 100 MB+ depending on Cloudflare plan |
| Container | `standard-2` instance; disk is ephemeral, persisted via R2 backups; region set by `KIMI_REGIONS` |
| Backups | `node_modules`, `.venv`, `__pycache__`, `.cache` and similar are not backed up (Kimi reinstalls them); `/workspace` over `BACKUP_MAX_MB` (4096) is not backed up and is reported in admin status |

## Operations

- Containers sleep after 30 minutes without requests, but not while Kimi is running a task
  (up to 6 hours unattended). They back up to R2 before sleeping, after uploads, when jobs are
  acknowledged, and when results are fetched.
- A new image applies to a container when it next starts. After a deploy that changed the
  image, wait until the rollout finishes (`npx wrangler containers info <id>` shows no
  `active_rollout_id`), then restart containers to apply it immediately:

```bash
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" \
  https://kimi-swarm-bridge.<sub>.workers.dev/admin/sandboxes/<sandbox-id>/restart
```

  Admin endpoints (all take the `ADMIN_TOKEN` bearer):

  | Endpoint | Purpose |
  |---|---|
  | `GET /admin/sandboxes/<id>` | backup status, skipped backups, today's ai& usage |
  | `POST …/backup` | back up now |
  | `POST …/restart` | stop the container; the next request restores and starts it |
  | `POST …/selftest` | checks inside the container: no real keys present; ai&, Firecrawl, HTTPS, git, pip and npm reachable (one small ai& request) |

  Sandbox IDs are `user-` + the first 40 hex characters of SHA-256 of the Access subject.
- `npm run smoke -- https://kimi-swarm-bridge.<sub>.workers.dev` checks a live deployment
  (OAuth discovery; MCP, file-link and admin endpoints reject unauthenticated callers). With
  `ADMIN_TOKEN` and `KIMI_SMOKE_SANDBOX=<sandbox-id>` set it also runs the self-test.
- Connecting a client or refreshing its tool list does not wake a sleeping container: the
  Worker answers the MCP handshake and tool list from a snapshot captured once per deploy.
- Backups expire after 90 days without a newer backup (R2 lifecycle).

## Security model

- Identity comes only from Cloudflare Access via OAuth; tool arguments never carry identity.
- One container per employee: an employee's agent (with full shell access) cannot reach
  another employee's files, sessions or processes.
- The Worker replaces the client's OAuth token with an internal token before forwarding;
  Kimi's REST API stays on loopback inside the container.
- The ai& and Firecrawl keys never enter containers. Containers hold placeholders; the Worker
  intercepts their requests to `api.aiand.com` and `api.firecrawl.dev` and attaches the real
  key, so an agent (or a prompt injection) with full shell access cannot read or exfiltrate it.
- File links are HMAC-signed with a per-container key derived from `BRIDGE_TOKEN`. The Worker
  verifies the signature before waking a container, so a link minted in one container cannot
  address another. Uploads are single-use, size-capped, optionally hash-bound, never overwrite
  and stay inside `/workspace`; downloads refuse paths (and symlinks) outside `/workspace`.
- Uploaded files never go to Firecrawl or other retrieval providers; file contents that Kimi
  reads are sent to ai& as model input.
