# xyte server image. Two targets:
#   docker build -t xyte .                 # full: HTTP + browser (Playwright Chromium), ~2 GB
#   docker build -t xyte:slim --target slim .   # HTTP only (httpResponseBody), ~250 MB
#
# Configure with env vars (see README): XYTE_PROVIDER + credentials or XYTE_PROXY_URL,
# XYTE_API_KEYS, XYTE_CONCURRENCY, XYTE_RETRIES, XYTE_TIMEOUT. Listens on $PORT (default 8080).

ARG PLAYWRIGHT_VERSION=1.64.1
ARG UNDICI_VERSION=8.12.3

# --- build: bun compiles dist/ (the runtime is plain Node) ---
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN bun run build

# --- slim: HTTP requests only ---
FROM node:22-slim AS slim
ARG UNDICI_VERSION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
# Runtime deps only; the repo's package.json lists them as devDependencies, which --omit=dev would skip.
RUN echo '{"private":true}' > package.json \
  && npm install --no-audit --no-fund undici@${UNDICI_VERSION} && npm cache clean --force
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.mjs", "serve"]

# --- full (default): HTTP + browser. The base image ships Chromium matching PLAYWRIGHT_VERSION. ---
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS full
ARG PLAYWRIGHT_VERSION
ARG UNDICI_VERSION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN echo '{"private":true}' > package.json \
  && npm install --no-audit --no-fund undici@${UNDICI_VERSION} playwright@${PLAYWRIGHT_VERSION} && npm cache clean --force
COPY --from=build /src/dist ./dist
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.mjs", "serve"]
