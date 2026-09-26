#!/usr/bin/env bash
# P9.4 — the whole non-hardware suite, one command.
# Hardware tests live in `npm run test:ledger:hardware` and are NOT run here.
#
# This harness now COUNTS. It used to print `tail -3` of each runner and nothing else, which meant
# nobody could state the cumulative total — and two phase groups reported numbers measured at
# different scopes (556 repository-wide, 444 Studio-only) that looked like a regression and were
# not. A gate that cannot add up its own suites cannot detect a suite going missing.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.cre/bin:$PATH"
[ -f .env ] && { set -a; . ./.env; set +a; }

FAIL=0
STEPS=()
TOT_PASS=0; TOT_FAIL=0; TOT_SKIP=0
COUNTS=()
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run () {
  local name="$1"; shift
  printf '\n\033[1m── %s ──\033[0m\n' "$name"
  if "$@"; then STEPS+=("PASS  $name"); else STEPS+=("FAIL  $name"); FAIL=1; fi
}

# A counted suite. `kind` says how to read the runner's own summary — we parse what the runner
# reports rather than counting test files, so a suite that fails to collect cannot be counted green.
counted () {
  local name="$1" kind="$2"; shift 2
  local log="$TMP/$(echo "$name" | tr -c 'a-zA-Z0-9' '_').log"
  printf '\n\033[1m── %s ──\033[0m\n' "$name"
  local ok=0
  "$@" >"$log" 2>&1 || ok=1
  tail -5 "$log"

  local p=0 f=0 s=0
  case "$kind" in
    vitest)
      # "Tests  68 passed | 5 skipped (73)"  /  "Tests  20 passed (20)"
      local line; line="$(grep -E '^ *Tests +' "$log" | tail -1)"
      p="$(sed -nE 's/.*[^0-9]([0-9]+) passed.*/\1/p' <<<"$line")"; p="${p:-0}"
      f="$(sed -nE 's/.*[^0-9]([0-9]+) failed.*/\1/p' <<<"$line")"; f="${f:-0}"
      s="$(sed -nE 's/.*[^0-9]([0-9]+) skipped.*/\1/p' <<<"$line")"; s="${s:-0}"
      ;;
    forge)
      # "Ran 12 test suites in ...: 106 tests passed, 0 failed, 2 skipped (108 total tests)"
      local line; line="$(grep -E '^Ran [0-9]+ test suites' "$log" | tail -1)"
      p="$(sed -nE 's/.*: ([0-9]+) tests passed.*/\1/p' <<<"$line")"; p="${p:-0}"
      f="$(sed -nE 's/.*passed, ([0-9]+) failed.*/\1/p' <<<"$line")"; f="${f:-0}"
      s="$(sed -nE 's/.*failed, ([0-9]+) skipped.*/\1/p' <<<"$line")"; s="${s:-0}"
      ;;
    bun)
      # " 41 pass" / " 0 fail" / " 2 skip"
      p="$(sed -nE 's/^ *([0-9]+) pass$/\1/p' "$log" | tail -1)"; p="${p:-0}"
      f="$(sed -nE 's/^ *([0-9]+) fail$/\1/p' "$log" | tail -1)"; f="${f:-0}"
      s="$(sed -nE 's/^ *([0-9]+) skip$/\1/p' "$log" | tail -1)"; s="${s:-0}"
      ;;
  esac

  # A suite that ran but reported nothing is a collection failure wearing a green hat.
  if [ "$p" -eq 0 ] && [ "$f" -eq 0 ] && [ "$s" -eq 0 ]; then
    printf '\033[31m  no test count parsed — treating as failure\033[0m\n'
    ok=1
  fi

  TOT_PASS=$((TOT_PASS + p)); TOT_FAIL=$((TOT_FAIL + f)); TOT_SKIP=$((TOT_SKIP + s))
  COUNTS+=("$(printf '%-22s %5s pass  %4s fail  %4s skip' "$name" "$p" "$f" "$s")")
  if [ $ok -eq 0 ] && [ "$f" -eq 0 ]; then STEPS+=("PASS  $name"); else STEPS+=("FAIL  $name"); FAIL=1; fi
}

run     "typecheck"        bash -c 'npm run typecheck 2>&1 | tail -3'
counted "contracts"        forge bash -c 'cd contracts && forge test'
run     "contracts fmt"    bash -c 'cd contracts && forge fmt --check >/dev/null 2>&1'
counted "protocol"         vitest bash -c 'cd packages/protocol && npx vitest run'
run     "adapters build"   bash -c 'cd packages/adapters && npx tsc -p tsconfig.json --noEmit'
counted "ledger (non-hw)"  vitest bash -c 'cd packages/ledger && npx vitest run'
counted "broker"           vitest bash -c 'cd apps/broker && npx vitest run'
# The CRE workflow is a bun project outside the npm workspace, so `npm install` does not reach it.
# On a clean clone its deps are absent; install them from the committed lockfile rather than failing
# with an opaque "Cannot find module '@chainlink/cre-sdk/test'". (P9.3)
counted "cre workflow"     bun bash -c 'cd workflows/cre-policy/contextlock-policy && { [ -d node_modules ] || { echo "bootstrapping bun deps from bun.lock"; bun install --frozen-lockfile; }; } && bun test'
run     "secret scan"      bash scripts/secret-scan.sh
run     "canary scan"      bash scripts/canary-scan.sh
run     "privilege audit"  bash scripts/privilege-audit.sh
run     "suite inventory"  bash scripts/suite-inventory.sh
# Phase 11 Studio. The isolation suite needs a Docker daemon; it reports SKIPPED loudly rather
# than passing when Docker is down, so a missing daemon cannot look like a green isolation check.
counted "studio"           vitest bash -c 'npx vitest run packages/studio-blueprint packages/studio-simulation packages/studio-templates packages/studio-adapters packages/studio-strategy packages/studio-org packages/studio-plan packages/studio-openapi packages/studio-deploy packages/studio-orchestrator packages/studio-runtime packages/studio-events packages/studio-network packages/studio-cre-sim packages/studio-reality packages/studio-lab packages/studio-control-plane packages/adapter-sdk packages/bridge apps/studio/ apps/agent-runtime'
# The product UI is apps/frontend (Next.js). It typechecks here; its screens are exercised
# against the live studio API rather than in jsdom.
run     "frontend typecheck" bash -c 'cd apps/frontend && npx tsc --noEmit -p tsconfig.json'
# LEGACY — apps/studio-web is the retired test-only studio UI, superseded by apps/frontend.
# Kept out of the suite so its jsdom claims cannot stand in for the real frontend.
# run     "studio web build" bash -c 'cd apps/studio-web && npx tsc -p tsconfig.json --noEmit && npx vite build >/dev/null 2>&1'
# counted "studio web components" vitest bash -c 'cd apps/studio-web && npx vitest run'
run     "npm audit"        bash -c 'npm audit --audit-level=high 2>&1 | tail -3'

printf '\n\033[1m════ SUMMARY ════\033[0m\n'
for s in "${STEPS[@]}"; do printf '  %s\n' "$s"; done
printf '\n\033[1m════ CUMULATIVE TEST COUNT ════\033[0m\n'
for c in "${COUNTS[@]}"; do printf '  %s\n' "$c"; done
printf '  %-22s %5s pass  %4s fail  %4s skip   (%s total)\n' "TOTAL" "$TOT_PASS" "$TOT_FAIL" "$TOT_SKIP" "$((TOT_PASS + TOT_FAIL + TOT_SKIP))"
printf '\n'
printf '  Ledger HARDWARE tests: NOT RUN (BLK-002) — see `npm run test:ledger:hardware`\n\n'
if [ $FAIL -eq 0 ]; then printf '\033[32mALL NON-HARDWARE SUITES PASS\033[0m\n'; exit 0
else printf '\033[31mFAILURES PRESENT\033[0m\n'; exit 1; fi
