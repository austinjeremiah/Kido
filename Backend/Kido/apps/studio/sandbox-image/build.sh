#!/usr/bin/env bash
# Build the Studio sandbox image. Run once on the host before the first Studio build.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${STUDIO_SANDBOX_IMAGE:-contextlock-studio-sandbox:node22}"
echo "building $IMAGE (this is the only step that needs the network)"
docker build -t "$IMAGE" .
echo
echo "verifying the image runs with NO network, as every build sandbox will:"
docker run --rm --network none "$IMAGE" \
  node -e "require.resolve('typescript');require.resolve('vitest');require.resolve('zod');require.resolve('viem');console.log('OK toolchain resolves with no network')"
