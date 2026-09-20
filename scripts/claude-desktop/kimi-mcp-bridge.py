#!/usr/bin/env python3

# Minimal Claude Desktop stdio -> remote Streamable HTTP MCP bridge.
# Reads line-delimited JSON-RPC from stdin, forwards to Glama, captures
# Mcp-Session-Id, accepts JSON or SSE, and writes JSON-RPC to stdout.

import json
import os
import sys
import urllib.error
import urllib.request

REMOTE_URL = os.environ.get(
    "KIMI_MCP_URL",
    "https://glama.ai/endpoints/bqnlviwzd5/mcp",
)
TOKEN = os.environ.get("GLAMA_TOKEN")

if not TOKEN:
    print("GLAMA_TOKEN is not set", file=sys.stderr)
    sys.exit(1)

session_id = None
protocol_version = "2025-11-25"


def log(message):
    print(f"[kimi-mcp-bridge] {message}", file=sys.stderr, flush=True)


def emit(message):
    sys.stdout.write(
        json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n"
    )
    sys.stdout.flush()


def parse_sse(body):
    text = body.decode("utf-8", errors="replace")
    messages = []
    data_lines = []

    def flush_event():
        nonlocal data_lines
        if not data_lines:
            return
        payload = "\n".join(data_lines).strip()
        data_lines = []
        if not payload:
            return
        try:
            messages.append(json.loads(payload))
        except json.JSONDecodeError:
            log(f"Ignoring non-JSON SSE data: {payload[:200]!r}")

    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r")
        if line == "":
            flush_event()
            continue
        if line.startswith("data:"):
            value = line[5:]
            if value.startswith(" "):
                value = value[1:]
            if value:
                data_lines.append(value)

    flush_event()
    return messages


def parse_response(response, body):
    content_type = response.headers.get("Content-Type", "").lower()
    if not body:
        return []

    if "text/event-stream" in content_type:
        return parse_sse(body)

    try:
        parsed = json.loads(body.decode("utf-8"))
        return parsed if isinstance(parsed, list) else [parsed]
    except Exception:
        log(
            "Remote returned an unsupported response body: "
            + body[:500].decode("utf-8", errors="replace")
        )
        return []


def forward(message):
    global session_id, protocol_version

    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        requested = (
            message.get("params", {}).get("protocolVersion")
            if isinstance(message.get("params"), dict)
            else None
        )
        if requested:
            protocol_version = requested

    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": protocol_version,
        "User-Agent": "kimi-claude-desktop-bridge/1.0",
    }

    if session_id:
        headers["Mcp-Session-Id"] = session_id

    request = urllib.request.Request(
        REMOTE_URL,
        data=json.dumps(message, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            new_session = response.headers.get("Mcp-Session-Id")
            if new_session:
                session_id = new_session

            body = response.read()
            messages = parse_response(response, body)

            if method == "initialize":
                for candidate in messages:
                    if not isinstance(candidate, dict):
                        continue
                    result = candidate.get("result")
                    if isinstance(result, dict):
                        negotiated = result.get("protocolVersion")
                        if negotiated:
                            protocol_version = negotiated

            return messages

    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        log(f"Remote HTTP {exc.code}: {body[:1000]}")
        if request_id is not None:
            return [{
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": f"Remote MCP HTTP {exc.code}: {body[:500]}",
                },
            }]
        return []

    except Exception as exc:
        log(f"Remote MCP request failed: {exc}")
        if request_id is not None:
            return [{
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": f"Remote MCP request failed: {exc}",
                },
            }]
        return []


log(f"Starting bridge to {REMOTE_URL}")

for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        log(f"Invalid JSON from Claude: {exc}")
        continue

    for response_message in forward(message):
        emit(response_message)
