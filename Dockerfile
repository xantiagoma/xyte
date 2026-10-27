# xyte server image. Two targets, published as ghcr.io/xantiagoma/xyte:<version> and :<version>-slim:
#   docker build -t xyte .                 # full: HTTP + browser (Playwright and Patchright Chromium), ~2 GB
#   docker build -t xyte:slim --target slim .   # HTTP only (httpResponseBody), ~250 MB
#
# Configured entirely with env vars (docs/configuration.md): XYTE_PROVIDER + credentials or
# XYTE_PROXY_URL, XYTE_API_KEYS, XYTE_REDIS_URL… Listens on $PORT (default 8080). Both carry the
# optional runtime deps those need (undici for proxies, ioredis for XYTE_REDIS_URL).

ARG PLAYWRIGHT_VERSION=1.64.1
ARG UNDICI_VERSION=8.12.3
ARG IOREDIS_VERSION=6.0.0
ARG VERSION=dev

# --- build: bun compiles dist/ (the runtime is plain Node, so this runs on the build machine's
# platform even for a multi-arch build) ---
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN bun run build

# --- slim: HTTP requests only ---
FROM node:22-slim AS slim
ARG UNDICI_VERSION
ARG IOREDIS_VERSION
ARG VERSION
LABEL org.opencontainers.image.source="https://github.com/xantiagoma/xyte" \
  org.opencontainers.image.description="xyte: Zyte API-compatible POST /v1/extract on any proxy (HTTP only)" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
# Runtime deps only; the repo's package.json lists them as devDependencies, which --omit=dev would skip.
RUN echo '{"private":true}' > package.json \
  && npm install --no-audit --no-fund undici@${UNDICI_VERSION} ioredis@${IOREDIS_VERSION} && npm cache clean --force
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.mjs", "serve"]

# --- full (default): HTTP + browser. The base image ships Chromium matching PLAYWRIGHT_VERSION. ---
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS full
ARG PLAYWRIGHT_VERSION
ARG UNDICI_VERSION
ARG IOREDIS_VERSION
ARG VERSION
LABEL org.opencontainers.image.source="https://github.com/xantiagoma/xyte" \
  org.opencontainers.image.description="xyte: Zyte API-compatible POST /v1/extract on any proxy (HTTP + browser)" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
# Patchright (XYTE_BROWSER=patchright) at the Playwright version uses the same Chromium build, so
# its install finds the base image's browser in place.
RUN echo '{"private":true}' > package.json \
  && npm install --no-audit --no-fund undici@${UNDICI_VERSION} ioredis@${IOREDIS_VERSION} playwright@${PLAYWRIGHT_VERSION} patchright@${PLAYWRIGHT_VERSION} \
  && npx patchright install chromium && npm cache clean --force
COPY --from=build /src/dist ./dist
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.mjs", "serve"]
