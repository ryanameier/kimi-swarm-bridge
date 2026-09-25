#!/bin/bash
set -euo pipefail

ACCOUNT="$(/usr/bin/id -un)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${KIMI_MCP_URL:?Set KIMI_MCP_URL to your bridge, for example https://mcp.example.com/mcp}"
export KIMI_MCP_URL

export KIMI_MCP_AUTH_TOKEN="$(/usr/bin/security find-generic-password \
  -a "$ACCOUNT" \
  -s "kimi-swarm-mcp" \
  -w)"

PYTHON3="${KIMI_MCP_PYTHON:-}"

if [ -z "$PYTHON3" ]; then
  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$candidate" ]; then
      PYTHON3="$candidate"
      break
    fi
  done
fi

if [ -z "$PYTHON3" ] || [ ! -x "$PYTHON3" ]; then
  echo "Could not locate python3. Set KIMI_MCP_PYTHON to an absolute python3 path." >&2
  exit 1
fi

exec "$PYTHON3" "$SCRIPT_DIR/kimi-mcp-bridge.py"
