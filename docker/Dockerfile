# =============================================================================
# Stage 1: builder — compiles everything from source
# =============================================================================
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc make \
    gobjc gnustep-devel libgnustep-base-dev \
    curl ca-certificates \
    openjdk-21-jdk \
    python3 \
    git \
  && rm -rf /var/lib/apt/lists/*

# Node.js 18+
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy non-bot source first
COPY hooks/        ./hooks/
COPY proxy/        ./proxy/
COPY tools/        ./tools/
COPY config/       ./config/

# Copy bot manifest first for better layer caching of npm ci
COPY bot/package*.json ./bot/

# Install Node.js deps (includes dev deps needed for TypeScript build)
RUN cd bot && npm ci

# Copy bot source after deps to avoid reinstalling on every source change
COPY bot/          ./bot/

# Build C hooks → libblockheads_hooks.so
RUN cd hooks && make

# Build Node.js bot → bot/build/ and prune dev deps for runtime copy
RUN cd bot && npm run build && npm prune --omit=dev

# Build Java proxy → standalone launcher
RUN cd proxy && ./gradlew :interceptor:installDist --no-daemon

# =============================================================================
# Stage 2: runtime — only what's needed to run
# =============================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    # GNUstep runtime (required by game server binary)
    libgnustep-base1.29 libobjc4 \
    libgnutls30 libxml2 libicu74 libavahi-client3 \
    libxslt1.1 libffi8 libnsl2 \
    # Node.js runtime
    curl ca-certificates \
    # Java runtime
    openjdk-21-jre-headless \
    # Python + LMDB
    python3 python3-lmdb \
    # Utilities
    procps \
  && rm -rf /var/lib/apt/lists/*

# Node.js 18+
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Copy built artifacts from builder
COPY --from=builder /build/hooks/libblockheads_hooks.so  /app/libblockheads_hooks.so
COPY --from=builder /build/bot/build/                    /app/bot/build/
COPY --from=builder /build/bot/node_modules/             /app/bot/node_modules/
COPY --from=builder /build/bot/package.json              /app/bot/package.json
COPY --from=builder /build/proxy/interceptor/build/install/interceptor/ /app/proxy/
COPY --from=builder /build/tools/                        /app/tools/
COPY --from=builder /build/config/config.example.json   /app/config/config.example.json
COPY --from=builder /build/config/quest-data.json        /app/config/quest-data.json

# Game server binary (bundled — already in public use on GitHub)
COPY docker/bin/blockheads_server171 /app/blockheads_server171
RUN chmod +x /app/blockheads_server171

# Custom GNUstep runtime libs (libdispatch + libBlocksRuntime)
COPY docker/libs/libdispatch.so      /usr/local/lib/libdispatch.so
COPY docker/libs/libBlocksRuntime.so /usr/local/lib/libBlocksRuntime.so
RUN ldconfig

# Entrypoint
COPY docker/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# UDP port players connect to (via proxy)
EXPOSE 15153/udp

ENTRYPOINT ["/app/docker-entrypoint.sh"]
