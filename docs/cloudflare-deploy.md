# Organization deployment on Cloudflare

This guide deploys Kimi Swarm for a whole organization. An admin sets it up once;
employees add nothing but a Claude connector and sign in with their work identity.

```text
Claude (web / desktop / Claude Code)
   │  remote MCP + OAuth
   ▼
Cloudflare Worker ── Cloudflare Access (your identity provider or one-time PIN)
   │  verified employee → one Sandbox per employee
   ▼
Sandbox container (per employee)
   ├─ Kimi Code 0.42 + native AgentSwarm (4 workers)
   ├─ MCP bridge (this repo) + file transfer
   ├─ firecrawl-mcp (web search / scrape for workers)
   └─ workbench: python3, pypdf, reportlab, python-docx, openpyxl, pillow, poppler, git, zip
        │ all Kimi inference → ai& (https://api.aiand.com/v1, moonshotai/kimi-k3)
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
  and **Zero Trust** (Free plan covers 50 users).
- ai& API key. Firecrawl API key (optional).
- Node 22, Docker (to build the container image), and `npx wrangler login`.

## 1. Sign-in: Access for SaaS (OIDC)

Zero Trust → **Access controls → Applications → Create new application → SaaS applications**:

| Field | Value |
|---|---|
| Application | `Kimi Swarm` (custom) |
| Authentication protocol | OIDC |
| Redirect URL | `https://kimi-swarm-bridge.<your-subdomain>.workers.dev/callback` |
| Scopes | `openid`, `email`, `profile` |
| Grant type | Authorization code with PKCE |
| Policy | Allow → your group or email domain (this is how you assign employees) |

Use your identity provider (Google Workspace, Okta, Entra, …) as the login method, or
One-time PIN for a pilot. Note the Client ID, Client secret and the authorization, token and
key (JWKS) endpoints.

## 2. Configure and deploy

```bash
cd cloudflare
npm install
npx wrangler kv namespace create OAUTH_KV      # put the id into wrangler.jsonc
npx wrangler r2 bucket create kimi-swarm-backups
```

Secrets (`npx wrangler secret put <NAME>` or `wrangler secret bulk`):

| Secret | Value |
|---|---|
| `AIAND_API_KEY` | ai& key |
| `FIRECRAWL_API_KEY` | Firecrawl key, or an empty string to disable web tools |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | from step 1 |
| `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL` | from step 1 |
| `BRIDGE_TOKEN` | random, e.g. `openssl rand -hex 32` (Worker↔container credential and file-link key root) |
| `COOKIE_ENCRYPTION_KEY` | random |
| `ADMIN_TOKEN` | random; protects the operator endpoints below |

```bash
npx wrangler deploy
```

The first deploy builds the container image from the repository `Dockerfile`
(`IMAGE_VARIANT=cloudflare`) and takes a few minutes.

## 3. Add the connector in Claude

Claude → **Settings → Connectors → Add custom connector** →
`https://kimi-swarm-bridge.<your-subdomain>.workers.dev/mcp`. On Team/Enterprise an owner can
add it for the organization. Each employee clicks **Connect** and signs in once.

For attachment hand-off through code execution, allow the upload domain:
**Settings → Capabilities → Allow network egress → Package managers only** and add
`*.<your-subdomain>.workers.dev` under *Additional allowed domains* (organization settings on
Team/Enterprise). Without it, Claude cannot move attachments into the workspace; it can still
share download links.

## Limits

| Layer | Limit |
|---|---|
| Claude chat attachment | 30 MB per file (Claude) |
| Upload link (this bridge) | 100 MB per file by default (`KIMI_MAX_UPLOAD_BYTES`); single use; 15 min |
| Download link | 1 hour, reusable until expiry |
| Worker request body | 100 MB+ depending on Cloudflare plan |
| Container | `standard-2` instance; disk is ephemeral, persisted via R2 backups |

## Operations

- Containers sleep after 30 minutes without requests, but not while Kimi is running a task
  (up to 6 hours unattended). They back up to R2 before sleeping, after uploads, when jobs are
  acknowledged, and when results are fetched.
- A new image applies to a container when it next starts. To apply it immediately:

```bash
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" \
  https://kimi-swarm-bridge.<sub>.workers.dev/admin/sandboxes/<sandbox-id>/restart
```

  `GET /admin/sandboxes/<id>` shows backup status; `POST …/backup` forces a backup. Sandbox IDs
  are `user-` + the first 40 hex characters of SHA-256 of the Access subject.
- Backups expire after 90 days without a newer backup (R2 lifecycle).

## Security model

- Identity comes only from Cloudflare Access via OAuth; tool arguments never carry identity.
- One container per employee: an employee's agent (with full shell access) cannot reach
  another employee's files, sessions or processes.
- The Worker replaces the client's OAuth token with an internal token before forwarding;
  Kimi's REST API stays on loopback inside the container.
- File links are HMAC-signed with a per-container key derived from `BRIDGE_TOKEN`. The Worker
  verifies the signature before waking a container, so a link minted in one container cannot
  address another. Uploads are single-use, size-capped, optionally hash-bound, never overwrite
  and stay inside `/workspace`; downloads refuse paths (and symlinks) outside `/workspace`.
- Uploaded files never go to Firecrawl or other retrieval providers; file contents that Kimi
  reads are sent to ai& as model input.
