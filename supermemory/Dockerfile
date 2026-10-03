# syntax=docker/dockerfile:1
# supermemory-server: official precompiled Linux binary from upstream releases,
# sha256-verified at build time. No official image exists upstream.
FROM debian:bookworm-slim

ARG SUPERMEMORY_VERSION=0.0.8
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) ARCH=x64 ;; \
      arm64) ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/supermemoryai/supermemory/releases/download/server-v${SUPERMEMORY_VERSION}"; \
    curl -fsSL -o /usr/local/bin/supermemory-server "$base/supermemory-server-linux-${ARCH}"; \
    curl -fsSL "$base/supermemory-server-linux-${ARCH}.sha256" \
      | awk '{print $1"  /usr/local/bin/supermemory-server"}' | sha256sum -c -; \
    chmod +x /usr/local/bin/supermemory-server

# The server resolves its database from $SUPERMEMORY_DATA_DIR, else $CWD/.supermemory.
# Pin both so a different working directory can never create an empty database.
ENV SUPERMEMORY_DATA_DIR=/data \
    SUPERMEMORY_NO_PROMPT=1
WORKDIR /data
VOLUME ["/data"]
EXPOSE 6767

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/supermemory-server"]
