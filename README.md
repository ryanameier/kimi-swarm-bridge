# Kimi AgentSwarm Bridge for ai&

An open-source MCP bridge for running Kimi Code — including native `AgentSwarm` — with inference provided through [ai&](https://aiand.com).

This fork is built around one runtime policy:

- inference always goes through `https://api.aiand.com/v1`
- credentials are supplied with `AIAND_API_KEY`
- the model is configurable with `KIMI_MODEL_NAME`
- the tested/default model is `moonshotai/kimi-k3`
- Kimi Code's REST API stays loopback-only
- the externally exposed interface is MCP

The project began as a fork of [`ximenchuifeng/codex-kimi-bridge`](https://github.com/ximenchuifeng/codex-kimi-bridge) and remains available under the MIT License.

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
moonshotai/kimi-k3
```

Other models exposed by ai& may work, but native AgentSwarm compatibility should be verified per model. `moonshotai/kimi-k3` is the currently tested default.

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
- Persistent MCP job/session state does not by itself provide tenant isolation. Multi-tenant deployments should add organization identity and workspace boundaries before being treated as hardened shared infrastructure.

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
- Docker runtime
- persistent Kimi state
- managed-host-compatible `/ping` and `PORT` handling

OpenWork integration and production multi-tenant identity are subsequent deployment milestones.

## Upstream and license

This repository is derived from:

- `ximenchuifeng/codex-kimi-bridge`
- https://github.com/ximenchuifeng/codex-kimi-bridge

The original copyright and MIT license are preserved in `LICENSE`.

Modifications in this fork are maintained by `ryanameier`.

MIT License.
