import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { applyAiandRuntimePolicy } from "./dist/runtime-policy.js";

const kimiCodeHome = process.env.KIMI_CODE_HOME || "/data/kimi-code";
const kimiHost = "127.0.0.1";
const kimiPort = process.env.KIMI_SERVER_PORT || "58627";
const kimiBaseUrl = `http://${kimiHost}:${kimiPort}`;

applyAiandRuntimePolicy(process.env);

// Register Internet MCP tools for Kimi (coordinator and coder workers load
// user-global servers from $KIMI_CODE_HOME/mcp.json). Stdio MCP children do not
// inherit the full environment, so the key is written into the server entry.
async function registerInternetTools() {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();

  if (!firecrawlKey || firecrawlKey === "disabled") {
    return;
  }

  const mcpPath = `${kimiCodeHome}/mcp.json`;
  let config = {};

  try {
    config = JSON.parse(await readFile(mcpPath, "utf8"));
  } catch {
    // No existing config.
  }

  // Every tool definition is re-sent on every model request (Firecrawl ships
  // ~29 tools, ~13k tokens), so only the tools research needs are enabled.
  const enabledTools = (process.env.KIMI_FIRECRAWL_TOOLS ||
    "firecrawl_search,firecrawl_scrape,firecrawl_map")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  config.mcpServers = {
    ...config.mcpServers,
    firecrawl: {
      command: "firecrawl-mcp",
      args: [],
      env: { FIRECRAWL_API_KEY: firecrawlKey },
      ...(enabledTools.includes("all") ? {} : { enabledTools }),
    },
  };

  await mkdir(kimiCodeHome, { recursive: true });
  await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

await registerInternetTools();

// Tell Kimi what the configured model can do (Kimi otherwise assumes image
// input, which text-only models such as GLM reject). Uses ai&'s catalog.
async function detectModelCapabilities() {
  if (process.env.KIMI_MODEL_CAPABILITIES) return;
  let capabilities = ["thinking"];
  try {
    const response = await fetch(`${process.env.KIMI_MODEL_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${process.env.KIMI_MODEL_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    const entry = (await response.json()).data?.find(
      (model) => model.id === process.env.KIMI_MODEL_NAME,
    );
    if (entry && Array.isArray(entry.capabilities)) {
      capabilities = [
        ...(entry.capabilities.includes("reasoning") ? ["thinking"] : []),
        ...(entry.capabilities.includes("vision") ? ["image_in"] : []),
      ];
    }
  } catch (error) {
    console.error(`Model catalog unavailable; assuming text-only: ${error}`);
  }
  process.env.KIMI_MODEL_CAPABILITIES = capabilities.join(",") || "thinking";
}

await detectModelCapabilities();

Object.assign(process.env, {
  KIMI_CODE_HOME: kimiCodeHome,
  // Kimi compacts its context at ~85% of this window. A smaller window keeps
  // long-running agents from re-sending very large contexts on every step.
  KIMI_MODEL_MAX_CONTEXT_SIZE:
    process.env.KIMI_MODEL_MAX_CONTEXT_SIZE ||
    process.env.KIMI_CONTEXT_WINDOW ||
    "131072",
  KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY:
    process.env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY || "4",

  KIMI_SERVER_URL: kimiBaseUrl,
  KIMI_AUTO_START: "false",
  KIMI_THINKING: process.env.KIMI_THINKING || "high",
  KIMI_PERMISSION_MODE:
    process.env.KIMI_PERMISSION_MODE || "auto",
  KIMI_BRIDGE_STATE_DIR:
    process.env.KIMI_BRIDGE_STATE_DIR || "/data/state",
  KIMI_MCP_TRANSPORT:
    process.env.KIMI_MCP_TRANSPORT || "http",
  KIMI_MCP_HTTP_HOST:
    process.env.KIMI_MCP_HTTP_HOST || "0.0.0.0",
  KIMI_MCP_HTTP_PORT:
    process.env.PORT || process.env.KIMI_MCP_HTTP_PORT || "3000",
});

let shuttingDown = false;

const kimi = spawn(
  "kimi",
  [
    "web",
    "--no-open",
    "--host",
    kimiHost,
    "--port",
    kimiPort,
    "--log-level",
    process.env.KIMI_LOG_LEVEL || "info",
  ],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

function forwardRedacted(stream) {
  let buffer = "";

  stream?.on("data", (chunk) => {
    buffer += chunk.toString();

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const redacted = line.replace(/#token=\S+/g, "#token=[REDACTED]");
      process.stderr.write(`${redacted}\n`);
    }
  });

  stream?.on("end", () => {
    if (buffer) {
      const redacted = buffer.replace(/#token=\S+/g, "#token=[REDACTED]");
      process.stderr.write(redacted);
    }
  });
}

forwardRedacted(kimi.stdout);
forwardRedacted(kimi.stderr);

kimi.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(
      `Kimi exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    process.exit(code ?? 1);
  }
});

async function waitForKimi() {
  const tokenPath = `${kimiCodeHome}/server.token`;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const token = (await readFile(tokenPath, "utf8")).trim();

      if (token) {
        const response = await fetch(`${kimiBaseUrl}/api/v1/meta`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          return;
        }
      }
    } catch {
      // Kimi is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Kimi did not become ready within 60 seconds");
}

let bridge;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (bridge && bridge.exitCode === null) {
    bridge.kill("SIGTERM");
  }

  if (kimi.exitCode === null) {
    kimi.kill("SIGTERM");
  }

  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await waitForKimi();

  const transport = process.env.KIMI_MCP_TRANSPORT;

  if (transport !== "stdio" && transport !== "http") {
    throw new Error(
      `Invalid KIMI_MCP_TRANSPORT: ${transport}. Expected stdio or http.`,
    );
  }

  const bridgeEntry =
    transport === "http"
      ? "/app/dist/http-entry.js"
      : "/app/dist/index.js";

  console.error(
    `Kimi ready on ${kimiBaseUrl}; starting MCP bridge over ${transport}`,
  );

  bridge = spawn("node", [bridgeEntry], {
    env: process.env,
    stdio:
      transport === "stdio"
        ? ["inherit", "inherit", "inherit"]
        : ["ignore", "inherit", "inherit"],
  });

  bridge.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `MCP bridge exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
      );

      shuttingDown = true;

      if (kimi.exitCode === null) {
        kimi.kill("SIGTERM");
      }

      process.exit(code ?? 1);
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));

  shuttingDown = true;

  if (kimi.exitCode === null) {
    kimi.kill("SIGTERM");
  }

  process.exit(1);
}
