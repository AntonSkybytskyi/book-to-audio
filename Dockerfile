# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# All dependencies, with build tools in case better-sqlite3 has no prebuilt binary.
FROM base AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Full source and dev tools. Also used by `docker compose run --rm check`.
FROM deps AS build
COPY . .
RUN pnpm build

FROM build AS prod-deps
RUN pnpm prune --prod

FROM debian:bookworm-slim AS fetch
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Piper TTS binary.
FROM fetch AS piper
ARG PIPER_VERSION=2023.11.14-2
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64;  sha=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992 ;; \
      arm64) arch=aarch64; sha=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${arch}.tar.gz"; \
    echo "$sha  /tmp/piper.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/piper.tar.gz -C /opt; \
    rm /tmp/piper.tar.gz

# Piper voice: en_US-lessac-medium from rhasspy/piper-voices at a pinned revision.
FROM fetch AS voices
ARG PIPER_VOICES_REVISION=5041a7a49ae5b3a0f30e6837769eb03fdbb231bd
RUN set -eu; \
    mkdir -p /opt/piper-voices; \
    cd /opt/piper-voices; \
    base="https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REVISION}/en/en_US/lessac/medium"; \
    curl -fsSL -o en_US-lessac-medium.onnx "$base/en_US-lessac-medium.onnx"; \
    curl -fsSL -o en_US-lessac-medium.onnx.json "$base/en_US-lessac-medium.onnx.json"; \
    echo "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f  en_US-lessac-medium.onnx" | sha256sum -c -; \
    echo "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0  en_US-lessac-medium.onnx.json" | sha256sum -c -

FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=piper /opt/piper /opt/piper
RUN ln -s /opt/piper/piper /usr/local/bin/piper
COPY --from=voices /opt/piper-voices /opt/piper-voices

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    PIPER_VOICES_DIR=/opt/piper-voices

COPY --from=prod-deps /app/node_modules ./node_modules
# Next writes .next/cache at runtime.
COPY --chown=node:node --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY package.json next.config.ts ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/server/index.js"]
