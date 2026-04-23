FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY metrics-bridge/package.json metrics-bridge/
# shared-config is a workspace dep of metrics-bridge. Copy the whole package
# before install so its `prepare` hook (tsc) can build dist/ from source.
COPY shared-config/ shared-config/

RUN corepack enable && pnpm install --frozen-lockfile --filter @mento-protocol/metrics-bridge

COPY metrics-bridge/ metrics-bridge/
RUN pnpm --filter @mento-protocol/metrics-bridge build

FROM node:22-alpine
WORKDIR /app

RUN addgroup -S bridge && adduser -S bridge -G bridge

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY metrics-bridge/package.json metrics-bridge/
COPY shared-config/package.json shared-config/
# --ignore-scripts skips the root `postinstall` (which runs `tsc` on shared-config)
# because the dist is copied from the builder below and the prod install has no
# devDeps. The workspace symlink still resolves at runtime.
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts --filter @mento-protocol/metrics-bridge

COPY --from=builder /app/metrics-bridge/dist ./metrics-bridge/dist
COPY --from=builder /app/shared-config/dist ./shared-config/dist
# Runtime needs the raw JSON exports (exports map points to ./*.json directly).
COPY shared-config/*.json shared-config/

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

USER bridge

CMD ["node", "metrics-bridge/dist/main.js"]
