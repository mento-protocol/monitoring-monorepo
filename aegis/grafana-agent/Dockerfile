# Official Grafana Alloy image, pinned by the multi-arch index digest to remove
# tag-mutability risk while letting App Engine select its Linux platform.
FROM grafana/alloy:v1.16.1@sha256:51aeb9d829239345070619dad3edd6873186f913c84f45b365b74574fcb38ec0

# Install jq + ensure curl is present so entrypoint.sh can call the GCE
# metadata server and Secret Manager. base64 ships in coreutils on Debian.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Add healthcheck.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD curl -fsS http://localhost:8080/-/healthy >/dev/null || exit 1

# Create a non-root user for security.
# The previous Agent image used this dedicated UID/GID to avoid base-image
# account collisions. Keep the runtime identity stable while moving to Alloy.
RUN groupadd -g 10001 agent && \
    useradd -u 10001 -g agent -M -s /usr/sbin/nologin agent

# Alloy stores WAL and component state under --storage.path. The directory is
# owned by root in the base image, so pre-create and chown for the non-root
# runtime user.
RUN mkdir -p /etc/alloy /var/lib/alloy/data && \
    chown -R agent:agent /etc/alloy /var/lib/alloy

# config.alloy reads Grafana Cloud credentials with sys.env(). The entrypoint
# script fetches the values from Secret Manager at container start and exports
# them before exec'ing Alloy. Neither file contains secret material.
COPY --chown=agent:agent config.alloy /etc/alloy/config.alloy
# `COPY --chmod=...` requires BuildKit, which Cloud Build's default Docker
# driver doesn't enable. App Engine's source-based build runs the legacy
# builder, so we chmod in a separate RUN step that works on both.
COPY --chown=agent:agent entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/entrypoint.sh

# Switch to non-root user
USER agent

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
