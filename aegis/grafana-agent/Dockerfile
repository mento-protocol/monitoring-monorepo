# grafana/agent:v0.43.4 is the last pre-Alloy-rename release and ships on
# Ubuntu Jammy 22.04 LTS (supported through April 2027). The previous pin
# at v0.35.0 sat on Ubuntu Lunar 23.04, EOL'd Jan 2024 and removed from
# the archive — `apt-get update` 404s, so the jq/curl install below fails.
# Pinned by digest to remove tag-mutability risk.
FROM grafana/agent:v0.43.4@sha256:6fdea192ec80f34548b2f722212df4185f36a346fddb6c9735b7a4f6e26b697e

# Install jq + ensure curl is present so entrypoint.sh can call the GCE
# metadata server and Secret Manager. base64 ships in coreutils on Debian.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:8080/-/healthy || exit 1

# Create a non-root user for security.
# `grafana/agent` is Debian-based (BusyBox `addgroup`/`adduser -D` aren't
# available) AND already uses GID/UID 1000 for its built-in `grafana`
# account, so we pick 10001 to avoid the collision.
RUN groupadd -g 10001 agent && \
    useradd -u 10001 -g agent -M -s /usr/sbin/nologin agent

# Prometheus WAL directory (configured in agent.yaml as `wal_directory`).
# /etc is owned by root, so the non-root `agent` user can't `mkdir` at
# runtime — pre-create and chown here.
RUN mkdir -p /etc/agent/data && chown -R agent:agent /etc/agent

# agent.yaml uses ${VAR} references for Grafana Cloud credentials. The
# entrypoint script fetches the values from Secret Manager at container
# start and `grafana-agent -config.expand-env=true` performs the
# substitution. Neither file contains any secret material.
COPY --chown=agent:agent agent.yaml /etc/agent/agent.yaml
COPY --chown=agent:agent --chmod=0555 entrypoint.sh /usr/local/bin/entrypoint.sh

# Switch to non-root user
USER agent

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
