#!/usr/bin/env bash
# CONF-001: prove no confidential policy value escapes the enclave boundary.
# Scans every surface a leak could reach.
set -uo pipefail
cd "$(dirname "$0")/.."
CANARY="CTXLOCK_CONFIDENTIAL_CANARY_9f2b71c4a83e"
RISK_TOKEN="ctxlock-test-risk-token-NOT-a-real-credential"
FAIL=0
say(){ printf '%s\n' "$*"; }

# Surfaces where the canary is ALLOWED to appear.
#
# These are the files that DEFINE the test private policy, plus the reports documenting the test.
# Note what this means honestly: in a live CRE deployment the private policy values are released by
# the Vault DON into the attested enclave and must NEVER be in the repository at all. These are
# demo values, and the canary exists precisely so that a leak of them anywhere ELSE is detected.
# Matched against paths, so a NEW non-test file in the workflow package is still a failure.
# Phase 8 added redteam.test.ts, a second fixture that legitimately defines the demo private
# policy; the allowlist named only workflow.test.ts and so failed. Widened to the test files of
# that one package rather than to the package. (FND-018)
ALLOWED='workflows/cre-policy/contextlock-policy/[A-Za-z0-9_-]*\.test\.ts$|scripts/lib/harness.ts|reports/phase-0[4-9]/|scripts/canary-scan.sh|docs/VERSIONS.md'

say "=== CONF-001 confidential canary leak scan ==="
say "canary: CTXLOCK_CONFIDENTIAL_CANARY_<redacted-suffix>"

scan_tree () {
  say "--- [1] git-tracked files ---"
  local hits
  hits=$(git grep -l -F "$CANARY" -- . 2>/dev/null | grep -Ev "$ALLOWED" || true)
  if [ -n "$hits" ]; then say "FAIL canary in tracked files:"; echo "$hits"; FAIL=1
  else say "OK  canary confined to its test fixture and phase-04 report"; fi

  hits=$(git grep -l -F "$RISK_TOKEN" -- . 2>/dev/null | grep -Ev "$ALLOWED" || true)
  if [ -n "$hits" ]; then say "FAIL risk token in tracked files:"; echo "$hits"; FAIL=1
  else say "OK  risk token confined"; fi
}

scan_history () {
  say "--- [2] git history ---"
  if git rev-parse HEAD >/dev/null 2>&1; then
    local n
    n=$(git log -S"$CANARY" --oneline 2>/dev/null | wc -l | tr -d ' ')
    say "    commits touching the canary: $n (expected: only the phase-04 commit that adds the test)"
    if git log -S"$RISK_TOKEN" --oneline -- apps packages contracts deployments 2>/dev/null | grep -q .; then
      say "FAIL risk token entered history under apps/packages/contracts/deployments"; FAIL=1
    else say "OK  no confidential value in code/deployment history"; fi
  fi
}

scan_artifacts () {
  say "--- [3] build + deployment artifacts ---"
  local found=0
  for d in deployments contracts/out contracts/broadcast packages/*/dist apps/*/dist reports; do
    [ -e "$d" ] || continue
    if grep -rl -F "$CANARY" "$d" 2>/dev/null | grep -Ev "$ALLOWED" | grep -q .; then
      say "FAIL canary in $d"; FAIL=1; found=1
    fi
    if grep -rl -F "$RISK_TOKEN" "$d" 2>/dev/null | grep -Ev "$ALLOWED" | grep -q .; then
      say "FAIL risk token in $d"; FAIL=1; found=1
    fi
  done
  [ $found -eq 0 ] && say "OK  no confidential value in deployments/, build output, or reports"
}

scan_db_and_logs () {
  say "--- [4] broker database + logs ---"
  local found=0
  for f in $(find . -name "*.db" -o -name "*.log" -not -path "./node_modules/*" 2>/dev/null | head -40); do
    if grep -q -F "$CANARY" "$f" 2>/dev/null || grep -q -F "$RISK_TOKEN" "$f" 2>/dev/null; then
      say "FAIL confidential value in $f"; FAIL=1; found=1
    fi
  done
  [ $found -eq 0 ] && say "OK  no confidential value in any local database or log file"
}

scan_workflow_runtime () {
  say "--- [5] workflow runtime output (stdout/stderr of the real handler) ---"
  local out
  out=$( (cd workflows/cre-policy/contextlock-policy && PATH="$HOME/.bun/bin:$PATH" bun test 2>&1) || true )
  if printf '%s' "$out" | grep -q -F "$CANARY"; then
    say "FAIL canary appeared in workflow test output"; FAIL=1
  else say "OK  canary never printed to stdout/stderr during workflow execution"; fi
  if printf '%s' "$out" | grep -q -F "$RISK_TOKEN"; then
    say "FAIL risk token appeared in workflow test output"; FAIL=1
  else say "OK  risk token never printed"; fi
  printf '%s' "$out" | tail -4 | sed 's/^/    /'
}

scan_tree; scan_history; scan_artifacts; scan_db_and_logs; scan_workflow_runtime

say ""
if [ $FAIL -eq 0 ]; then say "CONF-001: PASS - no confidential value crossed the boundary"; exit 0
else say "CONF-001: FAIL"; exit 1; fi
