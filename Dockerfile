ARG CLOUDFLARE_SANDBOX_VERSION=0.12.10
# Final image variant: "runtime" (default, self-hosted) or "cloudflare".
# Wrangler cannot pick a build target, so it sets this via image_vars.
ARG IMAGE_VARIANT=runtime

FROM node:22.19-bookworm-slim AS build

WORKDIR /app

RUN npm install --global pnpm@10.34.5

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.test.json ./
COPY src ./src

RUN pnpm build:core


FROM node:22.19-bookworm-slim AS base

ENV NODE_ENV=production
ENV KIMI_CODE_HOME=/data/kimi-code
ENV KIMI_SERVER_URL=http://127.0.0.1:58627
ENV KIMI_MODEL_NAME=moonshotai/kimi-k3
ENV KIMI_MODEL_PROVIDER_TYPE=openai
ENV KIMI_MODEL_BASE_URL=https://api.aiand.com/v1
ENV KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=4
ENV KIMI_THINKING=high
ENV KIMI_PERMISSION_MODE=auto
ENV KIMI_AUTO_START=false
ENV KIMI_BRIDGE_STATE_DIR=/data/state
ENV KIMI_MCP_TRANSPORT=http
ENV KIMI_MCP_HTTP_HOST=0.0.0.0
ENV KIMI_MCP_HTTP_PORT=3000

# Local workbench for deterministic file/document work (no SaaS needed for
# PDF/DOCX/XLSX/ZIP handling).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       file \
       git \
       jq \
       poppler-utils \
       python3 \
       python3-pip \
       ripgrep \
       tini \
       unzip \
       zip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages \
       openpyxl==3.1.5 \
       pillow==11.3.0 \
       pypdf==6.1.1 \
       python-docx==1.2.0 \
       reportlab==4.4.4 \
    && npm install --global @moonshot-ai/kimi-code@0.42.0 pnpm@10.34.5

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY supervisor.mjs ./supervisor.mjs

RUN mkdir -p \
      /data/kimi-code \
      /data/state \
      /data/jobs \
      /workspace \
    && git config --global user.email "container@localhost.invalid" \
    && git config --global user.name "Kimi Swarm Container" \
    && cd /workspace \
    && git init \
    && printf '# Container smoke workspace\n' > README.md \
    && git add README.md \
    && git commit -m "Initialize container workspace"


# Cloudflare Sandbox runtime: one container per employee.
# Build with: docker build --platform linux/amd64 --build-arg IMAGE_VARIANT=cloudflare .
# The sandbox control server owns port 3000, so the MCP bridge moves to 8080.
FROM docker.io/cloudflare/sandbox:${CLOUDFLARE_SANDBOX_VERSION} AS cloudflare-sandbox

FROM base AS cloudflare

# Persistent state lives under /home/kimi and /workspace, the directories the
# Sandbox backup API can snapshot to R2. The Durable Object restores those
# backups and then starts the supervisor, so the image has no startup command.
ENV KIMI_MCP_HTTP_PORT=8080
ENV KIMI_CODE_HOME=/home/kimi/kimi-code
ENV KIMI_BRIDGE_STATE_DIR=/home/kimi/state
ENV KIMI_JOB_DB_PATH=/home/kimi/jobs/jobs.sqlite
# claude.ai drops MCP calls at ~240 s; return a timeout status before that.
ENV KIMI_MAX_WAIT_MS=200000

# Tools the Sandbox backup/restore API runs inside the container
# (squashfs snapshots mounted through a FUSE overlay).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       fuse-overlayfs \
       fuse3 \
       squashfs-tools \
       squashfuse \
    && rm -rf /var/lib/apt/lists/*

# Public Internet tools for Kimi workers. The supervisor registers it in
# $KIMI_CODE_HOME/mcp.json when FIRECRAWL_API_KEY is provided.
RUN npm install --global firecrawl-mcp@3.25.4

COPY --from=cloudflare-sandbox /container-server /container-server

EXPOSE 8080

ENTRYPOINT ["/container-server/sandbox"]
CMD []


# Default image (self-hosted / Glama).
FROM base AS runtime

VOLUME ["/data"]

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/supervisor.mjs"]


FROM ${IMAGE_VARIANT} AS final
