# Kimi AgentSwarm Bridge for ai&

An open-source MCP bridge for running Kimi Code — including native `AgentSwarm` — with inference provided through [ai&](https://aiand.com).

This fork is built around one runtime policy:

- inference always goes through `https://api.aiand.com/v1`
- credentials are supplied with `AIAND_API_KEY`
- the model is configurable with `KIMI_MODEL_NAME`
- the default model is `zai-org/glm-5.3` (`moonshotai/kimi-k3` is also tested); users can switch models from chat
- Kimi Code's REST API stays loopback-only
- the externally exposed interface is MCP

The project began as a fork of [`ximenchuifeng/codex-kimi-bridge`](https://github.com/ximenchuifeng/codex-kimi-bridge) and remains available under the MIT License.

## Organization deployment

To give every employee Kimi Swarm in Claude — per-employee isolated workspaces, sign-in through your identity provider, file upload/download, and persistence — deploy the Cloudflare edition: see [docs/cloudflare-deploy.md](docs/cloudflare-deploy.md). Share [docs/using-kimi-swarm.md](docs/using-kimi-swarm.md) with employees.

## Benchmarks

Web research briefs, with Kimi Swarm (GLM-5.3 on ai&) and Claude (Claude Code, Opus) given the same brief at the same time. Measured 2026-09-25 on the Cloudflare deployment. The number of agents is Kimi's own choice, up to the cap.

| Brief | Kimi agents | Kimi time | Claude time | Empty cells ³ (Kimi / Claude) | Cost (Kimi / Claude) |
|---|---|---|---|---|---|
| 12 platforms, 7 fields | 4 | 3m49s | 1m00s | — | $0.78 / — |
| 12 platforms, 7 fields | 12 | 2m05s | 1m39s ¹ | — | $0.92 / — |
| 30 managed Postgres providers | 10 | 3m46s | 1m31s | 11 / 13 | — / — |
| 30 email APIs, with cost calculations | — | 4m46s | 1m59s | 7 / 45 | $1.42 / — |
| **30 vector databases, every cell required** | **15** | **4m26s** | **3m56s** | **17 / 14** | **$2.30 / ~$3–5 ²** |

¹ Separate run of the same brief; Claude's simultaneous rerun reused its earlier work (28s), so it isn't a fair comparison.
² Measured from the account's usage before and after. That session carried a long context, which raises Claude's cost.
³ Table cells marked n/d, not documented, not published, not found or unknown, counted the same way in both reports. Accuracy was not graded against a reference.

What the numbers show:

- **Short briefs:** Claude is faster. Kimi has a fixed overhead of about 2 minutes (starting the swarm and merging results) that small jobs can't hide.
- **Completeness:** in normal runs Kimi left far fewer cells empty (7 vs 45 on the email brief, 11 vs 13 on Postgres), because each worker keeps searching its own items. When both were told to fill every cell, they finished about level (17 vs 14 empty cells out of 150, slightly in Claude's favour).
- **Large, complete briefs:** the speed gap closes. Claude's extra checks ran one after another while Kimi's ran across 15 agents in parallel: 4m26s vs 3m56s, with Kimi costing roughly half.
- **Background work:** Kimi runs in its own sandbox, so Claude stays free for other work while a swarm runs.

Scaling beyond these tests: The agent cap goes up to 128 and can be raised live with no restart (`POST /admin/sandboxes/<id>/limits`); parallelism is set by `SWARM_CONCURRENCY` (20 here), which takes effect when the container restarts. The limit in practice is ai&'s per-organization rate limit (about 100 requests per window, shared by every key in the org); the 15-agent run used 158 requests in about 4 minutes. We expect Kimi to pull ahead on longer, wider jobs if the organization's ai& rate limit is raised, but that is a projection, not yet measured.

Moonshot's own results for Agent Swarm (Kimi K2.5, not these tests) point the same way. In wide-search tasks, the swarm needed 3–4.5× fewer critical steps than a single Kimi agent, which Moonshot reports as up to 4.5× less wall-clock time. It also scored higher than Claude Opus 4.5 on BrowseComp and WideSearch, which measure accuracy rather than speed ([Kimi K2.5 tech blog](https://www.kimi.ai/blog/kimi-k2-5)). Those runs used Moonshot's model and harness, with up to 100 sub-agents; this bridge defaults to GLM-5.3 and a cap of 20.

## What it provides

The bridge exposes Kimi Code through MCP with support for:

- task delegation
- synchronous delegate-and-wait workflows
- continuation of existing Kimi sessions
- waiting and polling
- handoff retrieval
- cancellation
- review packages
- recent-session discovery
- native Kimi Code `AgentSwarm`
- authenticated Streamable HTTP MCP
- persistent Kimi and bridge state under `/data`

The hosted container runs:

```text
MCP client
    |
    v
Streamable HTTP MCP :3000
    |
    v
Kimi bridge
    |
    v
Kimi Code server 127.0.0.1:58627
    |
    v
ai& https://api.aiand.com/v1
    |
    v
selected ai& model
```

Kimi's administrative REST API is intentionally not published outside the container.

## Requirements

For development:

- Git
- Node.js 22.19 or newer
- pnpm 10.x

The Docker image pins:

- Node.js 22.19
- `@moonshot-ai/kimi-code@0.42.0`
- pnpm 10.34.5

## ai& configuration

`AIAND_API_KEY` is required by the official runtime.

The following inference settings are enforced:

```text
Provider protocol: OpenAI-compatible
Base URL:          https://api.aiand.com/v1
Credential source: AIAND_API_KEY
```

The model remains configurable:

```bash
export KIMI_MODEL_NAME="moonshotai/kimi-k3"
```

If `KIMI_MODEL_NAME` is not set, the bridge defaults to:

```text
zai-org/glm-5.3
```

Other models exposed by ai& may work, but native AgentSwarm compatibility should be verified per model. `zai-org/glm-5.3` is the default and `moonshotai/kimi-k3` is also tested.

## Native AgentSwarm

Swarm execution uses Kimi Code's native session profile and native `AgentSwarm` tool.

The bridge does not implement a custom swarm layer.

For a swarm task it:

1. creates or uses a Kimi session
2. updates the session profile with `swarm_mode=true`
3. verifies swarm activation through Kimi status
4. submits the prompt
5. lets Kimi invoke its native `AgentSwarm` tool
6. waits for the coordinator to synthesize worker results

The pilot container defaults to:

```text
KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=4
```

## Docker

Build:

```bash
docker build -t kimi-swarm-bridge .
```

Generate an MCP bearer token:

```bash
export KIMI_MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
```

Set your ai& API key in the environment:

```bash
export AIAND_API_KEY="..."
```

Run:

```bash
docker run -d \
  --name kimi-swarm-bridge \
  -p 127.0.0.1:3000:3000 \
  -e AIAND_API_KEY \
  -e KIMI_MCP_AUTH_TOKEN \
  -v kimi-swarm-data:/data \
  kimi-swarm-bridge
```

Only MCP port `3000` should be published. Kimi remains on loopback inside the container.

## HTTP MCP

The Streamable HTTP endpoint is:

```text
POST /mcp
GET  /mcp
DELETE /mcp
```

Authentication:

```http
Authorization: Bearer <KIMI_MCP_AUTH_TOKEN>
```

Health endpoints:

```text
GET /healthz
GET /ping
```

`/ping` exists for managed-host health checks.

TLS is expected to be terminated by the hosting platform or reverse proxy.

## Runtime environment variables

Required:

```text
AIAND_API_KEY
KIMI_MCP_AUTH_TOKEN     when HTTP transport is used
```

Common optional settings:

```text
KIMI_MODEL_NAME
KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY
KIMI_THINKING
KIMI_PERMISSION_MODE
KIMI_MCP_TRANSPORT
KIMI_MCP_HTTP_HOST
KIMI_MCP_HTTP_PORT
PORT
```

The official runtime intentionally overrides attempts to redirect `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_PROVIDER_TYPE`, or `KIMI_MODEL_API_KEY` away from ai&.

## Persistent data

The container uses:

```text
/data
├── kimi-code/
├── jobs/
└── state/
```

Mount `/data` on persistent storage for hosted deployments.

## Handoff change metadata

Delegation handoffs report Git state using three separate fields:

- `committedChanges` — changes committed during the delegated Kimi session.
- `workingTreeChanges` — uncommitted changes currently present in the worktree.
- `initialDirtyPaths` — paths that were already modified before delegation began.

Keeping these fields separate lets an MCP client distinguish work produced by the
delegated task from pre-existing local changes.

## Local development

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Type-check:

```bash
pnpm typecheck
```

Build:

```bash
pnpm build
```

Run tests:

```bash
pnpm test
```

The optional local Codex plugin validator test is skipped when the external Codex `plugin-creator` validator is not installed.

## Claude Desktop on macOS

For Claude Desktop, the validated setup is a local stdio MCP entry that forwards
to the Glama-hosted bridge over Streamable HTTP:

```text
Claude Desktop
    ↓ stdio
local kimi-mcp-bridge.py
    ↓ Streamable HTTP + Glama bearer token
Glama-hosted kimi-swarm-bridge
    ↓
Kimi Code native AgentSwarm
    ↓
ai&
```

This path is intentionally different from a Claude **Web / Custom Connector**.
The hosted bridge itself works over authenticated Streamable HTTP, but cloud
connector/proxy layers can impose their own MCP session behavior. The local
stdio wrapper keeps Claude Desktop's side simple and normalizes the remote HTTP
session explicitly.

The wrapper uses only the Python standard library. It captures and reuses
`Mcp-Session-Id`, sends `MCP-Protocol-Version`, accepts JSON or SSE responses,
and keeps the Glama access token out of Claude's JSON configuration.

### 1. Verify the remote MCP before configuring Claude

Set a dedicated Glama access token without putting it in shell history:

```bash
read -s GLAMA_TOKEN
export GLAMA_TOKEN
echo
```

Initialize:

```bash
curl -sS -D /tmp/kimi-mcp-headers.txt \
  -o /tmp/kimi-mcp-init.txt \
  -X POST 'https://glama.ai/endpoints/bqnlviwzd5/mcp' \
  -H "Authorization: Bearer $GLAMA_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"kimi-desktop-test","version":"1.0.0"}}}'

cat /tmp/kimi-mcp-headers.txt
cat /tmp/kimi-mcp-init.txt
```

Capture the session ID returned by Glama:

```bash
MCP_SESSION_ID="$(
  awk 'tolower($1)=="mcp-session-id:" {
    gsub("\r","",$2)
    print $2
  }' /tmp/kimi-mcp-headers.txt
)"
echo "Session: $MCP_SESSION_ID"
```

Complete initialization and list tools:

```bash
curl -sS \
  -X POST 'https://glama.ai/endpoints/bqnlviwzd5/mcp' \
  -H "Authorization: Bearer $GLAMA_TOKEN" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -sS \
  -X POST 'https://glama.ai/endpoints/bqnlviwzd5/mcp' \
  -H "Authorization: Bearer $GLAMA_TOKEN" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Then verify one real tool call:

```bash
curl -sS \
  -X POST 'https://glama.ai/endpoints/bqnlviwzd5/mcp' \
  -H "Authorization: Bearer $GLAMA_TOKEN" \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kimi_bridge_status","arguments":{}}}'
```

Do not continue with Claude setup until these remote checks succeed.

### 2. Store the Glama token in macOS Keychain

With `GLAMA_TOKEN` still set from the verification step:

```bash
/usr/bin/security add-generic-password \
  -a "$(/usr/bin/id -un)" \
  -s "kimi-swarm-glama" \
  -w "$GLAMA_TOKEN" \
  -U >/dev/null

unset GLAMA_TOKEN
```

Verify that the Keychain item is readable:

```bash
/usr/bin/security find-generic-password \
  -a "$(/usr/bin/id -un)" \
  -s "kimi-swarm-glama" \
  -w >/dev/null && echo "Keychain credential available."
```

Use a dedicated/revocable Glama token for this client. Never commit it.

### 3. Install the local wrapper

From a checkout of this repository:

```bash
mkdir -p ~/.claude/bin

cp scripts/claude-desktop/kimi-mcp-bridge.py ~/.claude/bin/
cp scripts/claude-desktop/kimi-mcp-desktop.sh ~/.claude/bin/

chmod 700 ~/.claude/bin/kimi-mcp-bridge.py
chmod 700 ~/.claude/bin/kimi-mcp-desktop.sh
```

The launcher looks for Python in common macOS locations. If Python lives
elsewhere, set `KIMI_MCP_PYTHON` to its absolute path.

### 4. Add the local MCP server to Claude Desktop

Edit:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Merge this entry into the existing `mcpServers` object. Do not replace unrelated
Claude settings or other MCP servers:

```json
{
  "mcpServers": {
    "kimi-swarm-python-bridge": {
      "command": "/Users/YOUR_USERNAME/.claude/bin/kimi-mcp-desktop.sh",
      "args": []
    }
  }
}
```

Replace `YOUR_USERNAME` with the macOS account name from:

```bash
/usr/bin/id -un
```

Quit Claude Desktop completely with `Cmd-Q`, reopen it, then check
**Settings → Developer**. `kimi-swarm-python-bridge` should show as running.

### 5. Verify Claude can call the bridge

Ask Claude Desktop to use only `kimi-swarm-python-bridge` and call
`kimi_bridge_status`. A healthy hosted deployment should report values such as:

```text
healthzOk: true
authOk: true
status: ready
serverVersion: 0.42.0
backend: v2
```

For hosted delegation, use:

```text
cwd: /workspace
```

A local macOS path is not automatically visible inside the hosted Glama
runtime.

In the managed ai& deployment, **omit the `model` field**. The bridge resolves
the centrally configured Kimi model alias; passing a raw provider model ID such
as `moonshotai/kimi-k3` can fail because Kimi's profile API expects a configured
alias.

### Long jobs, durable recovery, and AgentSwarm evidence

For long-running work, prefer the asynchronous sequence:

1. Call `kimi_delegate_task`.
2. Keep the returned `jobId` and `sessionId` when available.
3. Call `kimi_wait_until_idle` with that session ID.
4. When the job is `idle`, call `kimi_get_handoff` or
   `kimi_review_package`.

`kimi_delegate_and_wait` remains convenient for work expected to finish while
the caller stays connected. Its wait may time out, and an MCP/client transport
may also disconnect before the tool response is delivered. Neither condition
means the underlying Kimi job should be submitted again.

When durable jobs are configured, recovery should start with
`kimi_recent_jobs`. The registry is persistent and connector-owned, so after a
client timeout, reconnect, or bridge restart it can recover the durable
`jobId`, bound Kimi `sessionId`, prompt ID, last known status, and cached
result/error data without relying on raw session-title guessing. After
recovering the session ID, continue with `kimi_wait_until_idle` and then
`kimi_get_handoff`.

The durable registry is an ownership and recovery index; Kimi remains the
source of truth for the live session and transcript. A direct
`kimi_get_handoff` refreshes the authoritative Kimi session status and
reconciles the durable job record.

Durable jobs are enabled only when both variables are configured:

```text
KIMI_ORGANIZATION_ID=<customer-or-organization-id>
KIMI_CONNECTOR_INSTANCE_ID=<stable-connector-instance-id>
```

The default SQLite database is:

```text
/data/kimi-swarm-bridge/jobs.sqlite
```

`KIMI_JOB_DB_PATH` can override that path. Hosted deployments should place the
database on persistent storage. The current pilot isolation model is one
isolated hosted connector/runtime per customer organization; possession of a
job ID or Kimi session ID is not treated as authorization.

For native AgentSwarm acceptance, the final `kimi_get_handoff` includes a
fresh structured `swarmEvidence` snapshot. Verify values such as:

```text
swarmEvidence.available: true
swarmEvidence.nativeAgentSwarmObserved: true
swarmEvidence.agentSwarmCallCount: 1
swarmEvidence.requestedWorkerCount >= 3
swarmEvidence.completedWorkerCount >= 3
```

The evidence is derived from Kimi wire/session records rather than from the
model's prose self-report.

### Admin-managed employee deployment

The local bridge can be installed centrally by customer IT/MDM. In that model,
employees do not need to edit JSON, handle the Glama token, install Kimi Code,
or know about the stdio-to-HTTP transport. Their visible workflow remains
Claude Desktop plus the preconfigured Kimi MCP tools.

The Python wrapper is suitable for validation and managed pilots. A signed
standalone binary can replace it later if an organization does not want to
depend on a system-managed Python installation.

## stdio MCP

The original stdio transport remains available:

```bash
node dist/index.js
```

The container defaults to Streamable HTTP transport for hosted use.

## Security notes

- Never commit `AIAND_API_KEY`.
- Never commit `KIMI_MCP_AUTH_TOKEN`.
- Kimi's REST API should remain bound to `127.0.0.1`.
- Expose the MCP endpoint through HTTPS in hosted environments.
- Durable job ownership requires both `KIMI_ORGANIZATION_ID` and `KIMI_CONNECTOR_INSTANCE_ID`; job IDs and Kimi session IDs are not authorization credentials.
- Persistent MCP job/session state does not by itself provide hardened multi-tenant isolation. The Docker image is meant for one connector/runtime per organization; for many employees use the Cloudflare edition, which gives each signed-in employee their own container and keeps API keys out of containers.

## Status

Validated so far:

- ordinary Kimi inference through ai&
- `moonshotai/kimi-k3`
- native Kimi AgentSwarm
- four concurrent native workers
- coordinator and workers all using ai&
- cancellation
- authenticated Streamable HTTP MCP
- MCP disconnect/reconnect with job recovery
- Docker runtime (HTTP and stdio transports)
- persistent Kimi state
- managed-host-compatible `/ping` and `PORT` handling

Validated on the Cloudflare edition ([docs/cloudflare-deploy.md](docs/cloudflare-deploy.md)):

- per-employee sign-in (Cloudflare Access OIDC) and isolated containers
- files in and out of Claude chats through signed, single-use links
- persistence of jobs, sessions and workspace files across container restarts
- ai& and Brave Search keys held by the Worker, never inside containers
- web research via Brave Search and a page reader that returns only relevant facts
- per-employee daily ai& request budget and optional outbound logging/allowlist
- per-employee agent ceiling set from chat
- connector handshake and tool list served without waking a sleeping container
- research, repository, download and coding tasks with web access

See [CHANGELOG.md](CHANGELOG.md) for release notes. OpenWork integration is a later milestone.

## Upstream and license

This repository is derived from:

- `ximenchuifeng/codex-kimi-bridge`
- https://github.com/ximenchuifeng/codex-kimi-bridge

The original copyright and MIT license are preserved in `LICENSE`.

Modifications in this fork are maintained by `ryanameier`.

MIT License.
