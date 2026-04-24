FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY metrics-bridge/package.json metrics-bridge/
# shared-config is a workspace dep of metrics-bridge; its postinstall runs tsc
# to produce dist/, so the whole package (incl. src/ + tsconfig.json) must be
# present before `pnpm install`.
COPY shared-config/ shared-config/

# The trailing `...` on the filter includes transitive workspace deps — without
# it, pnpm symlinks shared-config but skips installing ITS own deps (notably
# @mento-protocol/contracts), so shared-config's postinstall `tsc` fails with
# "Cannot find module '@mento-protocol/contracts/contracts.json'".
RUN corepack enable && pnpm install --frozen-lockfile --filter "@mento-protocol/metrics-bridge..."

COPY metrics-bridge/ metrics-bridge/
RUN pnpm --filter @mento-protocol/metrics-bridge build

FROM node:22-alpine
WORKDIR /app

RUN addgroup -S bridge && adduser -S bridge -G bridge

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY metrics-bridge/package.json metrics-bridge/
# Copy shared-config's package.json + runtime JSON exports (the `exports` map
# points at `./*.json` directly). Covers both the install step below AND the
# runtime JSON resolution in the final image.
COPY shared-config/*.json shared-config/
# Trailing `...` on the filter pulls in shared-config's prod deps (most
# importantly @mento-protocol/contracts, which `shared-config/dist/tokens.js`
# requires at runtime). Without it, `node dist/main.js` crashes with
# module-not-found on the first chain-metadata lookup.
# --ignore-scripts skips the root `postinstall` (which runs `tsc` on shared-config)
# because the dist is copied from the builder below and the prod install has no
# devDeps for tsc to run with.
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@mento-protocol/metrics-bridge..."

COPY --from=builder /app/metrics-bridge/dist ./metrics-bridge/dist
COPY --from=builder /app/shared-config/dist ./shared-config/dist

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

USER bridge

CMD ["node", "metrics-bridge/dist/main.js"]
