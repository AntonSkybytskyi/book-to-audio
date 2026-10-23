# syntax=docker/dockerfile:1.7
# The core API. Build from the repository root: docker build -f apps/api/Dockerfile .

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# The workspace manifests, with build tools in case better-sqlite3 has no prebuilt binary.
FROM base AS manifests
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/edge/package.json apps/edge/
COPY apps/piper-api/package.json apps/piper-api/
COPY packages/contracts/package.json packages/contracts/

# Only this app and the packages it uses.
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@book-to-audio/api..."

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter "@book-to-audio/api..." build

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@book-to-audio/api..."

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

# Piper voices, one per language, from rhasspy/piper-voices at a pinned revision (docs/decisions/voices.md):
# en_US-lessac-medium, uk_UA-ukrainian_tts-medium (three speakers, the app uses lada) and ru_RU-ruslan-medium.
FROM fetch AS voices
ARG PIPER_VOICES_REVISION=5041a7a49ae5b3a0f30e6837769eb03fdbb231bd
RUN set -eu; \
    mkdir -p /opt/piper-voices; \
    cd /opt/piper-voices; \
    base="https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REVISION}"; \
    voice() { \
      for ext in onnx onnx.json; do \
        curl -fsSL -o "$2.$ext" "$base/$1/$2.$ext"; \
      done; \
      echo "$3  $2.onnx" | sha256sum -c -; \
      echo "$4  $2.onnx.json" | sha256sum -c -; \
    }; \
    voice en/en_US/lessac/medium en_US-lessac-medium \
      5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f \
      efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0; \
    voice uk/uk_UA/ukrainian_tts/medium uk_UA-ukrainian_tts-medium \
      7920419ac5f6fd8b6450520f24b52ed5a319cb53dd018fbcd71c9e079cbac84f \
      4e96e72917ca9b94edc77d6ccfee03a73f450ba2fc1ca93c2e562bc014e5aa55; \
    voice ru/ru_RU/ruslan/medium ru_RU-ruslan-medium \
      72a5f88e0b20928064eb45d88e1daa21f8af62d18613580d32cbb4aed48dcf7f \
      706a4fb17bc304abd07809b552deae615e64dcbffbfbd09854ba37ca59e88117

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

# pnpm keeps the packages in /app/node_modules and links them from each workspace folder.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
WORKDIR /app/apps/api

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/index.js"]
