#!/usr/bin/env bash
# Every test file in the repository must belong to a suite the cumulative harness runs.
#
# This exists because a suite hid for two phase groups. `workflows/cre-policy/contextlock-cre/policy`
# contained a bun test file that `test-all.sh` never ran and that had never passed — it was the CRE
# scaffold's stock cron example, left behind when the workflow was rewritten for EVM log triggers.
# Nothing failed, because nothing looked.
#
# A test that no harness runs is worse than no test: it reads as coverage.
set -uo pipefail
cd "$(dirname "$0")/.."

# Directories the cumulative harness actually executes. Adding a test outside these is the error
# this script exists to catch, so extending the list means extending test-all.sh in the same commit.
COVERED=(
  "contracts/test"
  "packages/protocol/test"
  "packages/ledger/test"
  "packages/studio-blueprint/test"
  "packages/studio-simulation/test"
  "packages/studio-templates/test"
  "packages/studio-adapters/test"
  "packages/studio-strategy/test"
  "packages/studio-org/test"
  "packages/studio-plan/test"
  "packages/studio-openapi/test"
  "packages/studio-deploy/test"
  "packages/studio-orchestrator/test"
  "packages/studio-runtime/test"
  "packages/studio-events/test"
  "packages/studio-network/test"
  "packages/studio-cre-sim/test"
  "packages/studio-reality/test"
  "packages/studio-lab/test"
  "packages/studio-control-plane/test"
  "packages/adapter-sdk/test"
  "packages/bridge/test"
  "apps/broker/test"
  "apps/studio/test"
  # "apps/studio-web/test"   # LEGACY test-only UI, superseded by apps/frontend
  "apps/agent-runtime/test"
  "workflows/cre-policy/contextlock-policy"
)

# Vendored dependencies and build output are not ours to run.
# The legacy UIs (apps/web, apps/studio-web) are retired, not orphaned: apps/frontend replaced them.
EXCLUDE_RE='(^\./node_modules/|/node_modules/|^\./contracts/lib/|^\./contracts/out/|^\./apps/studio-web/|^\./apps/web/|^\./apps/frontend/\.next/)'

orphans=0
while IFS= read -r f; do
  [[ "$f" =~ $EXCLUDE_RE ]] && continue
  rel="${f#./}"
  covered=0
  for dir in "${COVERED[@]}"; do
    case "$rel" in "$dir"/*) covered=1; break;; esac
  done
  if [ $covered -eq 0 ]; then
    printf '  ORPHAN  %s\n' "$rel"
    orphans=$((orphans + 1))
  fi
done < <(find . \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.t.sol' \) 2>/dev/null)

if [ $orphans -gt 0 ]; then
  printf '\n%d test file(s) belong to no suite the cumulative harness runs.\n' "$orphans"
  printf 'Either wire the suite into scripts/test-all.sh and add it to COVERED here, or delete it.\n'
  exit 1
fi
printf 'SUITE INVENTORY: every test file is covered by the cumulative harness\n'
