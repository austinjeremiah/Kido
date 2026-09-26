#!/usr/bin/env bash
# P28 mutation runner for the product-surface guards added in the completion pass.
#
# Each entry disables ONE guard, runs the suite that owns it, and requires the ONE named test to
# fail. A mutation the suite survives means the guard has no test — which is the only thing a
# mutation run can actually tell you.
#
# The file is restored from git after every case, including on failure.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
ROWS=()

# An eighth argument of "ESCAPE_EXPECTED" marks a guard that is redundant by construction: the
# mutation is still run and still reported, and surviving it is the recorded result rather than a
# failure. Anything not marked that way must be caught.
mutate () {
  local n="$1" desc="$2" file="$3" from="$4" to="$5" suite="$6" expect="$7" mode="${8:-MUST_CATCH}"
  cp "$file" "/tmp/p28-mut-backup.$$"
  if ! grep -qF "$from" "$file"; then
    printf '\033[31m %2s  ANCHOR MISSING in %s\033[0m\n' "$n" "$file"
    ROWS+=("$(printf '%3s  %-56s %-16s %-14s %s' "$n" "$desc" "$suite" "$expect" "ANCHOR MISSING")")
    FAIL=1; rm -f "/tmp/p28-mut-backup.$$"; return
  fi
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
open(path, "w").write(s.replace(frm, to, 1))
PY

  local out; out="$(npx vitest run "$suite" -t "$expect" 2>&1)"
  cp "/tmp/p28-mut-backup.$$" "$file"; rm -f "/tmp/p28-mut-backup.$$"

  if grep -qE '[0-9]+ failed' <<<"$out"; then
    printf '\033[32m %2s  CAUGHT   %s\033[0m\n' "$n" "$desc"
    ROWS+=("$(printf '%3s  %-56s %-16s %-14s %s' "$n" "$desc" "$suite" "$expect" "CAUGHT")")
  elif [ "$mode" = "ESCAPE_EXPECTED" ]; then
    printf '\033[33m %2s  ESCAPED (expected, redundant guard)  %s\033[0m\n' "$n" "$desc"
    ROWS+=("$(printf '%3s  %-56s %-16s %-14s %s' "$n" "$desc" "$suite" "$expect" "ESCAPED — redundant, held above")")
  else
    printf '\033[31m %2s  ESCAPED  %s\033[0m\n' "$n" "$desc"
    printf '%s\n' "$out" | tail -6
    ROWS+=("$(printf '%3s  %-56s %-16s %-14s %s' "$n" "$desc" "$suite" "$expect" "ESCAPED")")
    FAIL=1
  fi
}

L=packages/studio-lab/src
W=apps/studio-web/src

mutate 23 "simulation layers may share an explanation" \
  "$L/simulation-center.ts" \
  'const prior = seen.get(key);' \
  'const prior = undefined as string | undefined;' \
  packages/studio-lab "SIM-001c"

mutate 24 "an absent deployed parity result counted as a match" \
  "$L/cre-connect.ts" \
  'match: notRun === null && differences.length === 0,' \
  'match: differences.length === 0,' \
  packages/studio-lab "PARITY-002"

mutate 25 "a test asset given a real-world value" \
  "$L/deploy-ux.ts" \
  'realWorldValue: "NONE",
      automaticallyRequested: false,
    });
  }' \
  'realWorldValue: "NONE", usdValue: "$3.02",
      automaticallyRequested: false,
    } as TokenRequirement);
  }' \
  packages/studio-lab "TOKEN-001b"

mutate 26 "an already-enabled policy treated as ready to activate" \
  "$L/deploy-ux.ts" \
  'status: input.policyEnabled ? "NOT_READY" : "READY",' \
  'status: "READY" as const,' \
  packages/studio-lab "ACT-001c"

mutate 27 "the fork explorer resolver no longer consulted" \
  "$L/shadow-ux.ts" \
  'if (url !== null) {' \
  'if (false) {' \
  packages/studio-lab "SHADOWUX-002b"

# 28a is expected to ESCAPE, and the reason is recorded rather than hidden: `applyOverlay` copies
# every observation before changing it, so the base cannot change and the layer above holds the
# property without this line. Reported honestly instead of deleted, because a mutation that survives
# is a fact about the guard, not a failure of the run.
mutate 28a "the base-unchanged hash comparison (redundant by construction)" \
  "$L/scenario-lab.ts" \
  'assertBaseUnchanged(base, before);' \
  '/* removed */' \
  packages/studio-lab "SHOCK-002" ESCAPE_EXPECTED

mutate 28b "the base hash recomputation after a shock" \
  "$L/scenario-lab.ts" \
  'verifySnapshotHash(base);' \
  '/* removed */' \
  packages/studio-lab "SHOCK-002c"

mutate 29 "the private-policy scan on a decision view" \
  "$L/decision.ts" \
  'if (blob.includes(`"${field.toLowerCase()}"`)) {' \
  'if (false) {' \
  packages/studio-lab "DECISION-002c"

mutate 30 "an unobserved graph node defaulted to PASS" \
  "$W/runtime-overlay.ts" \
  'states[node.id] = "PENDING";
    }' \
  'states[node.id] = "PASS";
    }' \
  apps/studio-web "COMP-018d"

mutate 31 "a stale reading keeps the value it reported" \
  "$W/runtime-overlay.ts" \
  'return reading.isCurrent ? whenCurrent : "WARN";' \
  'return whenCurrent;' \
  apps/studio-web "COMP-018c"

printf '\n%3s  %-56s %-16s %-14s %s\n' "#" "guard disabled" "suite" "caught by" "result"
for r in "${ROWS[@]}"; do printf '%s\n' "$r"; done
if [ $FAIL -eq 0 ]; then printf '\n\033[32mevery mutation behaved as recorded\033[0m\n'; else printf '\n\033[31mAN UNEXPECTED MUTATION ESCAPED\033[0m\n'; fi
exit $FAIL
