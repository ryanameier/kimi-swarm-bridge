# Changelog

## 0.4.0 (2026-09-25)

Organization deployment on Cloudflare: every employee gets Kimi Swarm in Claude with their own
isolated workspace, signing in through the organization's identity provider. Admin guide:
[docs/cloudflare-deploy.md](docs/cloudflare-deploy.md).

### Cloudflare edition (`cloudflare/`)

- One Sandbox container per employee behind Cloudflare Access OIDC sign-in
  (workers-oauth-provider). The Access policy decides who gets Kimi Swarm.
- `npm run setup`: one-command, re-runnable setup (KV, R2, secrets, regions, limits, deploy,
  health check). `npm run smoke`: post-deploy checks.
- Persistence: `/workspace` and Kimi state are backed up to R2 and restored when a container
  starts. Job records are backed up before a delegated task is acknowledged. Dependencies and
  caches are excluded, and `/workspace` above `BACKUP_MAX_MB` is skipped (reported to admins).
- Keys stay out of containers. The Worker intercepts requests to ai& and Firecrawl and attaches
  the real keys; containers only hold placeholders.
- Outbound policy `EGRESS_MODE`: `open` (default), `log` (every outbound HTTP(S) request is
  logged), or `allowlist` (`EGRESS_ALLOWLIST`).
- Per-employee daily ai& request budget (`AIAND_DAILY_REQUEST_LIMIT`, default 3000).
- The Worker answers the MCP handshake and tool list from a snapshot, so connecting does not
  wake a sleeping container and sessions survive container restarts.
- Containers stay awake while Kimi works (up to 6 hours unattended) and sleep after 30 minutes
  idle.
- Admin endpoints: list employees, status and usage, backup, restart, in-container self-test,
  offboarding (revokes sign-ins, destroys the container, deletes its state and backups), and
  backup listing/deletion.
- Backups are named after their sandbox; each directory keeps its two newest backups, and setup
  adds a 90-day R2 expiry rule for employees who stop using Kimi Swarm.
- Container workbench: python3, pypdf, reportlab, python-docx, openpyxl, pillow, poppler, git,
  zip, ripgrep, jq; `firecrawl-mcp` for web search and scraping.

### Bridge

- Files: signed single-use upload links and download links (`kimi_create_upload_links`,
  `kimi_create_download_links`, `kimi_list_files`; the singular names remain as aliases).
  MCP server instructions tell Claude to move chat attachments to `/workspace/inputs` and to
  bring deliverables from `/workspace/outputs` back into the conversation.
- `kimi_file_panel`: an in-chat upload/download panel (MCP App) for hosts other than Claude.
- `kimi_swarm_settings`: each user sets their AgentSwarm ceiling from chat, up to the
  deployment cap. Kimi still decides how many workers a task needs; `SWARM_CONCURRENCY`
  bounds how many run at once.
- Waits are clamped by `KIMI_MAX_WAIT_MS` so hosted clients get a timeout status instead of a
  dropped call. Prompts can name the coordinator (`KIMI_COORDINATOR_NAME`).
- Stateless Streamable HTTP mode for fronting proxies (`x-kimi-mcp-mode: stateless`).

### Fixes

- `/authorize` returns 400 instead of 500 for unknown OAuth clients.
- The Codex plugin bundle includes `kimi_swarm_settings`.

### Project

- CI runs typecheck and tests for the bridge and the Cloudflare Worker.

## 0.3.4 and earlier

See the git history and tags `v0.3.1`–`v0.3.4`.
