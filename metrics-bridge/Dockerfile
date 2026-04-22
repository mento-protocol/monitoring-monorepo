FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY metrics-bridge/package.json metrics-bridge/

RUN corepack enable && pnpm install --frozen-lockfile --filter @mento-protocol/metrics-bridge

COPY metrics-bridge/ metrics-bridge/
RUN pnpm --filter @mento-protocol/metrics-bridge build

FROM node:22-alpine
WORKDIR /app

RUN addgroup -S bridge && adduser -S bridge -G bridge

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY metrics-bridge/package.json metrics-bridge/
RUN corepack enable && pnpm install --prod --frozen-lockfile --filter @mento-protocol/metrics-bridge

COPY --from=builder /app/metrics-bridge/dist ./metrics-bridge/dist

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

USER bridge

CMD ["node", "metrics-bridge/dist/main.js"]
