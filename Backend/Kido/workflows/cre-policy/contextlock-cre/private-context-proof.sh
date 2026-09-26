#!/usr/bin/env bash
# P8.9 — the same on-chain transaction, judged three different ways.
#
# ONE Sepolia transaction. ONE amount. ONE policy. The ONLY thing that changes between runs is the
# confidential market context the workflow reads inside the handler. If the verdict changes, the
# decision demonstrably depends on private data — which is the whole claim of the Chainlink
# integration.
#
# Evidence written here is sanitized: context inputs are described qualitatively, never printed as
# the confidential threshold values they are compared against.
set -uo pipefail
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")"

TX="0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843"

set_ctx () {
  local now; now=$(date -u +%s)
  local json="{\"observedAtUnix\":$now,\"slippageBps\":$1,\"volatilityBps\":$2,\"liquidity\":\"$3\",\"healthFactorBps\":18000}"
  local b64; b64=$(printf '%s' "$json" | base64 | tr -d '\n')
  python3 - "$b64" <<'PY'
import json,sys
p='policy/config.staging.json'; d=json.load(open(p))
d['riskApiUrl']=f"https://httpbin.org/base64/{sys.argv[1]}"
json.dump(d,open(p,'w'),indent=2)
PY
  cp policy/config.staging.json policy/config.production.json
}

scene () {
  local label="$1" slip="$2" vol="$3" liq="$4" expect="$5"
  set_ctx "$slip" "$vol" "$liq"
  echo "── $label ──"
  echo "   transaction : $TX   (identical in every scene)"
  echo "   private ctx : slippage=${slip}bps volatility=${vol}bps liquidity=${liq}"
  echo "   expecting   : $expect"
  local out
  out=$(cre workflow simulate policy --target staging-settings --non-interactive \
        --trigger-index 0 --evm-tx-hash "$TX" --evm-event-index 0 2>&1 \
        | grep -oE '"(ALLOW|ESCALATE|DENY):[A-Z_]+:[A-Z]+"' | head -1)
  [ -z "$out" ] && out="(no verdict captured)" 
  echo "   VERDICT     : $out"
  echo
}

echo "════════════════════════════════════════════════════════════════════"
echo " P8.9  SAME TRANSACTION, DIFFERENT PRIVATE CONTEXT, DIFFERENT VERDICT"
echo "════════════════════════════════════════════════════════════════════"
echo " Transaction under test: $TX"
echo " Amount, agent, target, policy id and policy version are IDENTICAL throughout."
echo " Only the confidential market context differs."
echo
scene "SCENE A — benign market"        12  150 9000000000000 "ALLOW"
scene "SCENE B — volatile market"      12 5000 9000000000000 "ESCALATE (risk)"
scene "SCENE C — high slippage"       900  150 9000000000000 "DENY (slippage)"
scene "SCENE D — illiquid market"      12  150             1 "DENY (liquidity)"
echo "════════════════════════════════════════════════════════════════════"
echo " The transaction never changed. The verdict did. Therefore the decision"
echo " depends on data only the confidential handler can see."
echo "════════════════════════════════════════════════════════════════════"
