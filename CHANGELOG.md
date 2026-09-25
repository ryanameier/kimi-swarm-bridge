# Changelog

## Unreleased

- Faster swarms: the coordinator is shown the exact AgentSwarm call shape (its first launch was
  often rejected and retried), workers get a soft tool-call budget by depth (5 / 8 / 14) so one
  worker can't hold up the swarm, and `read_page` stops waiting for a slow page 8s after half the
  batch is done (reader model timeout 20s, browser 15s).
- `kimi-assemble`: joins the workers' section files into one document (one contiguous table,
  sections in order) without a model. In a 15-worker run the coordinator had spent 4 minutes
  repairing a hand-assembled report.
- Cloudflare defaults for new deployments: 20 agents per task (Kimi uses fewer when it can), 20
  running at once, and `EGRESS_MODE=log`. Existing deployments keep their settings on re-run.
- Setup writes `cloudflare/employee-guide.<worker>.md`, the employee guide with the connector URL
  and domain filled in. The guide gained copy-paste starter prompts and the one extra step for
  personal Claude Pro/Max accounts.
- README cleanup: removed the Glama-hosted Claude Desktop walkthrough and pilot wording. The
  Claude Desktop wrapper in `scripts/claude-desktop/` now needs `KIMI_MCP_URL` and reads the token
  from the Keychain item `kimi-swarm-mcp` (was `kimi-swarm-glama`, with a Glama URL hardcoded).
- README: benchmarks of Kimi Swarm vs Claude on web research briefs (time, completeness, cost) and
  what limits scaling past them.
- `kimi_model_settings`: users switch the ai& models Kimi uses from chat, separately for the
  coordinator and the AgentSwarm workers (for example a cheaper worker model). The tool lists the
  ai& models with live prices; admins can narrow the list with `KIMI_ALLOWED_MODELS`. Choices are
  per user, persist, and are applied through Kimi Code's config (hot reloaded, no restart).
- Task results report token usage per agent and an estimated USD cost from ai& prices.
- Kimi is told to use the fewest workers that do the task well, overriding Kimi Code's default
  guidance to maximize agents; the per-user ceiling stays an upper bound.
- The admin self-test reports which bridge build a container runs.
- Default model is `zai-org/glm-5.3` (deployment setting `AIAND_MODEL`, setup `KIMI_MODEL`);
  model capabilities (for example image input) come from the ai& catalog. New deployments start
  at 4 agents with a user-adjustable cap of 20.
- Failed tasks report why (`failureReason`, from Kimi's turn record), for example exhausted model
  credits.
- Web research replaces Firecrawl: `web_search` (Brave Search API, `BRAVE_API_KEY`) and
  `read_page`, which fetches a page and returns only the requested facts via a small reader model
  (`KIMI_READER_MODEL`), with Cloudflare Browser Rendering for JavaScript pages. The Worker
  attaches the Brave key and retries Brave rate limits. Firecrawl and `FIRECRAWL_API_KEY` are
  removed.
- Lower token use per step: small web tool definitions, Kimi compacts context at a 128k window
  (`KIMI_CONTEXT_WINDOW`), and workers keep notes and return concise summaries.
- `docs/using-kimi-swarm.md`: a one-page guide for employees.

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
- Per-employee daily ai& request budget (`AIAND_DAILY_REQUEST_LIMIT`, default 3000). Account-level
  ai& or Firecrawl errors (for example exhausted credits) are logged as `egress-upstream-error`.
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
