# Organization deployment on Cloudflare

This guide deploys Kimi Swarm for a whole organization. An admin sets it up once;
employees add nothing but a Claude connector and sign in with their work identity.

```text
Claude (web / desktop / Claude Code)
   │  remote MCP + OAuth
   ▼
Cloudflare Worker ── Cloudflare Access (your identity provider or one-time PIN)
   │  verified employee → one Sandbox per employee
   │  holds the ai& / Brave Search keys; answers the MCP handshake itself
   ▼
Sandbox container (per employee, placeholder keys only)
   ├─ Kimi Code 0.42 + native AgentSwarm
   ├─ MCP bridge (this repo) + file transfer
   ├─ web tools: web_search (Brave) and read_page (fetch + small reader model;
   │  JavaScript pages rendered by Cloudflare Browser Rendering)
   └─ workbench: python3, pypdf, reportlab, python-docx, openpyxl, pillow, poppler, git, zip
        │ all Kimi inference → ai& (https://api.aiand.com/v1; default zai-org/glm-5.3)
        │ outbound calls to ai& / Brave pass through the Worker, which adds the key
R2: workspace and Kimi-state backups (restored automatically when a container restarts)
```

Accounts needed: **Cloudflare**, **ai&**, and **Brave Search API** (for web search; free monthly credit,
then $5 per 1,000 searches). Page reading and JavaScript rendering use your Cloudflare account.

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
- ai& API key, with credits added before the first test: a new ai& organization starts on an
  evaluation tier and moves up after its first payment, and an empty balance makes every task
  fail. Brave Search API key (https://brave.com/search/api/; optional, but without it Kimi
  cannot search the web).
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
(below), validates your ai&, Brave Search and Access values, generates the internal secrets,
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

Every prompt has an environment variable: `AIAND_API_KEY`, `BRAVE_API_KEY` (`disabled`
to turn off web search), `ACCESS_TEAM`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`,
`KIMI_WORKER_NAME`, `KIMI_REGIONS` (e.g. `ENAM,WNAM`), `KIMI_JURISDICTION` (`eu` or
`fedramp`), plus the limits and policies below (`KIMI_SWARM_CONCURRENCY`,
`KIMI_MAX_AGENTS_CAP`, `KIMI_DEFAULT_MAX_AGENTS`, `KIMI_DAILY_REQUEST_LIMIT`,
`KIMI_AIAND_CONCURRENCY`, `KIMI_EGRESS_MODE`, `KIMI_EGRESS_ALLOWLIST`). Re-runs keep previous values unless a variable
overrides them. Run `npm run setup -- --yes`. `--rotate-internal` replaces the generated
`BRIDGE_TOKEN`, `COOKIE_ENCRYPTION_KEY` and `ADMIN_TOKEN`.

Setup writes `wrangler.deploy.jsonc` (account-specific, git-ignored). Later deploys:
`npm run deploy`. Additional deployments on the same account (for example a pilot, with
`KIMI_WORKER_NAME=kimi-swarm-pilot`) get their own `wrangler.<name>.deploy.jsonc`, sign-in
storage and backup bucket; add each deployment's `/callback` URL to the Access application's
redirect URLs.

Give employees `cloudflare/employee-guide.<worker-name>.md`, which setup writes at the end: the
one-page [using-kimi-swarm.md](using-kimi-swarm.md) guide with your connector URL and domain
filled in.

Recommended: give everyone the Kimi Swarm skill (`skills/kimi-swarm/`, packaged as
`kimi-swarm.zip` on each GitHub release; build it with `cd skills && zip -r kimi-swarm.zip
kimi-swarm`). Claude apps that load connector tools on demand (the desktop app, Claude Code) don't
show the connector's own guidance to the model, so without the skill Claude only uses Kimi when
asked. With it, Claude offers Kimi for big, independent parts of a request.

- Team and Enterprise: an organization owner uploads it once under **Organization settings →
  Plugins & skills** (on the **Policy** tab, **Skills** and **Code execution and file creation**
  must be on). It is enabled for every employee automatically; each can turn it off for
  themselves. See [Provision and manage skills for your organization](https://support.claude.com/en/articles/13119606-provision-and-manage-skills-for-your-organization).
- Individual plans: each user uploads `kimi-swarm.zip` themselves (see the employee guide).
- Claude Code: org-provisioned skills may not reach Claude Code; developers can copy the
  `kimi-swarm` folder into `~/.claude/skills/`.

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

- **Models.** New users start on `AIAND_MODEL` (setup: `KIMI_MODEL`, default `zai-org/glm-5.3`).
  Employees switch models from chat ("which models can Kimi use?", "use GLM-5.3 for the
  workers") via `kimi_model_settings`, separately for the coordinator and the workers; the
  worker model drives most of the cost. `KIMI_ALLOWED_MODELS` (comma-separated ids) limits the
  choice. Task results include token usage and an estimated cost.
- **Agents per task (a ceiling).** Kimi decides how many AgentSwarm workers each task needs and
  is told to use the fewest that do the job well; the ceiling only bounds it. It starts at
  `DEFAULT_MAX_AGENTS` (20). Employees change their own ceiling from chat ("raise the Kimi agent
  limit to 8", via `kimi_swarm_settings`), up to `MAX_AGENTS_CAP` (20; Kimi's hard maximum is 128).
- **Workers calling ai& at once (a guardrail).** `SWARM_CONCURRENCY` (20) limits how many
  workers run simultaneously per employee; extra workers wait in a rolling queue and start as
  soon as a running worker finishes. Keep it at least as high as the ceiling, or a higher
  ceiling adds workers without adding speed. It is read when a container starts. Each
  employee's container has its own limit.
- **ai& rate limit (organization-wide).** ai& limits how many model requests an organization
  has in flight at once, shared by all its keys; responses report it as `X-RateLimit-Limit`
  (100 on a new account, 1000 after the first payment at the time of writing). The Worker keeps
  the whole deployment under `AIAND_CONCURRENCY_LIMIT` (setup: `KIMI_AIAND_CONCURRENCY`,
  default 100, `0` = off): extra requests wait their turn instead of failing with HTTP 429 and
  Kimi's backoff. Set it to your ai& limit, or change it live with no restart:
  `POST /admin/aiand-limit` with `{"concurrency": 1000}` (`null` returns to the configured
  value). `GET /admin/aiand-limit` shows requests in flight, queued, the peak and total waiting.
- **Daily budget per employee.** `AIAND_DAILY_REQUEST_LIMIT` (3000) caps ai& model requests
  per employee per UTC day; `0` means unlimited. The Worker counts every model call on its way
  out; over the limit, Kimi gets a quota error and reports it instead of retrying.
  `GET /admin/sandboxes/<id>` shows today's count.

Set these with `KIMI_SWARM_CONCURRENCY`, `KIMI_MAX_AGENTS_CAP`, `KIMI_DEFAULT_MAX_AGENTS`,
`KIMI_DAILY_REQUEST_LIMIT` and `KIMI_AIAND_CONCURRENCY` when running `npm run setup`.

## Outbound internet access

Kimi's workers need the internet to research, download files, clone repositories and install
packages. `EGRESS_MODE` (setup: `KIMI_EGRESS_MODE`) chooses the policy:

| Mode | Behaviour |
|---|---|
| `open` | Everything allowed; only ai& and Brave Search traffic goes through the Worker. |
| `log` (default) | Everything allowed; every outbound HTTP(S) request is logged (host, method, sandbox) to Workers Logs as `{"event":"egress",…}`. |
| `allowlist` | Only hosts matching `EGRESS_ALLOWLIST` (comma-separated, `*` globs, e.g. `*.github.com,pypi.org,files.pythonhosted.org,registry.npmjs.org`) plus ai& and Brave Search; others get HTTP 403. |

In `log` and `allowlist` modes HTTPS is inspected with a Cloudflare-issued certificate that
the container trusts (git, curl, pip, npm, Python and Node pick it up automatically). The
policy covers HTTP and HTTPS; other protocols (for example SSH to git hosts) are not
filtered. Changing modes takes effect for each container when it next starts.

## Web research

Workers get two tools. `web_search` queries the Brave Search API (50 queries per second; the
key is shared by the whole deployment). `read_page` fetches a page and has a small, fast ai&
model (`KIMI_READER_MODEL`, default `deepseek-ai/deepseek-v4-flash`, about $0.003 per page)
return only the facts the worker asked for, so full pages never fill the worker's context.
Pages built with JavaScript are rendered by Cloudflare Browser Rendering (10 browser-hours a
month included with Workers Paid, then $0.09 per hour). Search requests that hit Brave's rate
limit are retried by the Worker, so workers never wait them out.

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
  | `POST …/selftest` | checks inside the container: no real keys present; ai&, Brave search, browser rendering, HTTPS, git, pip and npm work (one small ai& request); reports the running build |
  | `GET /admin/sandboxes` | signed-in employees: sandbox id, name, number of sign-ins |
  | `DELETE /admin/sandboxes/<id>` | offboard: revoke the employee's sign-ins, destroy their container, delete its state and backups |
  | `GET /admin/backups` | every backup in R2 with owner sandbox, size and date |
  | `DELETE /admin/backups/<backup-id>` | delete one backup |
  | `GET`/`POST /admin/aiand-limit` | organization-wide ai& requests in flight: see usage, set `{"concurrency": n}`, `null` to reset, `{"resetStats": true}` |

  Sandbox IDs are `user-` + the first 40 hex characters of SHA-256 of the Access subject;
  `GET /admin/sandboxes` lists them with names. To remove an employee, take them out of the
  Access policy (so they cannot sign in again) and call `DELETE /admin/sandboxes/<id>`.
- `npm run smoke -- https://kimi-swarm-bridge.<sub>.workers.dev` checks a live deployment
  (OAuth discovery; MCP, file-link and admin endpoints reject unauthenticated callers). With
  `ADMIN_TOKEN` and `KIMI_SMOKE_SANDBOX=<sandbox-id>` set it also runs the self-test.
- Connecting a client or refreshing its tool list does not wake a sleeping container: the
  Worker answers the MCP handshake and tool list from a snapshot captured once per deploy.
- Each directory keeps its two newest backups. Backups expire after 90 days without a newer
  backup (an R2 lifecycle rule that setup creates).

## Security model

- Identity comes only from Cloudflare Access via OAuth; tool arguments never carry identity.
- One container per employee: an employee's agent (with full shell access) cannot reach
  another employee's files, sessions or processes.
- The Worker replaces the client's OAuth token with an internal token before forwarding;
  Kimi's REST API stays on loopback inside the container.
- The ai& and Brave Search keys never enter containers. Containers hold placeholders; the Worker
  intercepts their requests to `api.aiand.com` and `api.search.brave.com` and attaches the real
  key, so an agent (or a prompt injection) with full shell access cannot read or exfiltrate it.
- File links are HMAC-signed with a per-container key derived from `BRIDGE_TOKEN`. The Worker
  verifies the signature before waking a container, so a link minted in one container cannot
  address another. Uploads are single-use, size-capped, optionally hash-bound, never overwrite
  and stay inside `/workspace`; downloads refuse paths (and symlinks) outside `/workspace`.
- Uploaded files never go to search providers; file contents that Kimi
  reads are sent to ai& as model input.
