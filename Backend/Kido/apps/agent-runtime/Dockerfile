# syntax=docker/dockerfile:1.7
#
# The ContextLock agent runtime image.
#
# Multi-stage, so the toolchain that builds the runtime is not in the image that runs it. A
# container carrying a compiler and a package manager is a container in which an attacker who gets
# code execution can build whatever they like next.
#
# The base is pinned by DIGEST, not by tag. `node:22-bookworm-slim` is a moving pointer: pinning it
# would mean this Dockerfile describes a different image tomorrow, and the SBOM produced today would
# describe software that is no longer in it.
#
# Everything about the security posture that CAN be baked into the image is baked in here — the
# non-root user, the absence of a shell-accessible toolchain, the absence of any credential. The
# rest (read-only root filesystem, dropped capabilities, no-new-privileges, resource limits) is a
# property of how the container is RUN, and lives in DockerRuntimeProvider, because a Dockerfile
# cannot enforce it.

ARG BASE_DIGEST=sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# ─────────────────────────────── build stage ───────────────────────────────
FROM node@${BASE_DIGEST} AS build
WORKDIR /build

COPY apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/agent-runtime/tsconfig.json ./apps/agent-runtime/tsconfig.json
COPY apps/agent-runtime/src ./apps/agent-runtime/src

# `npm ci` needs a lockfile scoped to this package; the runtime has exactly one runtime dependency,
# so it is installed explicitly and pinned, rather than dragging the monorepo's full tree in.
RUN cd apps/agent-runtime \
 && npm install --no-audit --no-fund --omit=dev zod@4.1.12 \
 && npm install --no-audit --no-fund --save-dev typescript@5.9.3 @types/node@22.18.11 \
 && npx tsc -p tsconfig.json \
 && npm prune --omit=dev

# ────────────────────────────── runtime stage ──────────────────────────────
FROM node@${BASE_DIGEST} AS runtime

# A dedicated unprivileged user. Created here rather than relying on the base image's `node` user so
# that the uid/gid this image runs as is a property of this Dockerfile and cannot change underneath
# it when the base image does.
RUN groupadd --gid 10001 contextlock \
 && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin --no-create-home contextlock

# ---
# The directory the scoped runtime credential is delivered into.
#
# A real directory in the image, not a tmpfs. `docker cp` into a CREATED container writes to that
# container's own layer, and a tmpfs mount does not exist until the container starts — so a token
# copied before start would land nowhere. Owned by the runtime user so it can read the file, and
# left read-only at run time by `--read-only`, which means a compromised process can read its own
# credential and cannot forge a different one.
#
# The token is never baked into the image: `docker cp` writes to the container layer, and the
# container is removed when the runtime is stopped.
RUN mkdir -p /run/contextlock /tmp/contextlock \
 && chown 10001:10001 /run/contextlock /tmp/contextlock \
 && chmod 0500 /run/contextlock

WORKDIR /app
COPY --from=build --chown=root:root --chmod=0555 /build/apps/agent-runtime/dist ./dist
COPY --from=build --chown=root:root --chmod=0555 /build/apps/agent-runtime/node_modules ./node_modules
COPY --from=build --chown=root:root --chmod=0444 /build/apps/agent-runtime/package.json ./package.json

# Root-owned and read-only to the runtime user, so a compromised process cannot rewrite its own
# code. This is what makes `--read-only` at run time a reinforcement rather than the only control.

USER 10001:10001
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384 \
    CONTEXTLOCK_HEALTH_PORT=8080 \
    CONTEXTLOCK_SCRATCH_DIR=/tmp/contextlock
EXPOSE 8080

# `node`, not a shell. There is no shell form here, so there is no `/bin/sh -c` in the process tree
# to inherit, and a signal reaches the runtime directly rather than a shell that ignores it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.CONTEXTLOCK_HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/main.js"]

# Traceability. These are read back off the running image and compared with the DeploymentManifest;
# an image whose labels do not match what was approved is not the image that was approved.
ARG SOURCE_COMMIT=unknown
ARG BUILD_ID=unknown
ARG BLUEPRINT_HASH=unknown
ARG STRATEGY_HASH=unknown
ARG AGENT_ID=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="ContextLock agent runtime" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.digest="${BASE_DIGEST}" \
      com.contextlock.build-id="${BUILD_ID}" \
      com.contextlock.blueprint-hash="${BLUEPRINT_HASH}" \
      com.contextlock.strategy-hash="${STRATEGY_HASH}" \
      com.contextlock.agent-id="${AGENT_ID}" \
      com.contextlock.holds-credentials="none" \
      com.contextlock.is-cre-runtime="false"
