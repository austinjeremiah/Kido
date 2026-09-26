# ContextLock Studio sandbox image.
#
# Dependencies are installed HERE, on the host, at image build time — so every build sandbox can run
# with networkMode: 'none' for its entire life. See FND-V2-003: the Docker sandbox client offers no
# per-stage network toggle, only "none" or unrestricted outbound, and unrestricted outbound while
# model-generated DeFi code executes is the thing to avoid.
#
# Nothing in this image is model-authored. The dependency list is written by ContextLock.
FROM node:22-bookworm-slim

# Pinned so the image is reproducible and an upstream change cannot alter what a build compiles
# against without a visible diff here.
ENV TYPESCRIPT_VERSION=5.9.3 \
    VITEST_VERSION=3.2.7 \
    ZOD_VERSION=4.1.12 \
    VIEM_VERSION=2.56.3

WORKDIR /opt/agent-deps

RUN printf '%s\n' '{"name":"agent-deps","private":true,"type":"module"}' > package.json \
 && npm install --no-audit --no-fund \
      typescript@${TYPESCRIPT_VERSION} \
      vitest@${VITEST_VERSION} \
      zod@${ZOD_VERSION} \
      viem@${VIEM_VERSION} \
 && npm cache clean --force

# Generated projects resolve from here. NODE_PATH plus a workspace symlink keeps the generated
# package.json honest about what it depends on while needing no install step at build time.
ENV NODE_PATH=/opt/agent-deps/node_modules
ENV PATH=/opt/agent-deps/node_modules/.bin:$PATH

RUN mkdir -p /workspace
WORKDIR /workspace

# A sanity assertion baked into the image: if the toolchain is not present, fail at image build
# rather than halfway through a user's build inside a network-less container where nothing can be
# fetched to recover.
RUN node -e "require.resolve('typescript'); require.resolve('vitest'); require.resolve('zod'); console.log('toolchain ok')"
