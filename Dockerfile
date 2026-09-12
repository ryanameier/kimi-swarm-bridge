FROM node:22.19-bookworm-slim AS build

WORKDIR /app

RUN npm install --global pnpm@10.34.5

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.test.json ./
COPY src ./src

RUN pnpm build:core


FROM node:22.19-bookworm-slim AS runtime

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

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
       tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @moonshot-ai/kimi-code@0.42.0

WORKDIR /app

RUN npm install --global pnpm@10.34.5

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

VOLUME ["/data"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/supervisor.mjs"]
