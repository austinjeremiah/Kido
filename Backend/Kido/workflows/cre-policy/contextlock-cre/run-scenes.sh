#!/usr/bin/env bash
# Runs the three verdict scenes through the OFFICIAL CRE simulator against REAL Sepolia events.
# The market context is regenerated immediately before each run because the workflow refuses
# context older than 120s — that freshness rule is a security control, not test friction.
set -uo pipefail
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")"

fresh_ctx () {
  local now; now=$(date -u +%s)
  local json="{\"observedAtUnix\":$now,\"slippageBps\":${1:-12},\"volatilityBps\":${2:-150},\"liquidity\":\"9000000000000\",\"healthFactorBps\":18000}"
  local b64; b64=$(printf '%s' "$json" | base64 | tr -d '\n')
  python3 - "$b64" <<'PY'
import json,sys
p='policy/config.staging.json'; d=json.load(open(p))
d['riskApiUrl']=f"https://httpbin.org/base64/{sys.argv[1]}"
json.dump(d,open(p,'w'),indent=2)
PY
  cp policy/config.staging.json policy/config.production.json
}

run () {
  local label="$1" tx="$2" slip="${3:-12}" vol="${4:-150}"
  fresh_ctx "$slip" "$vol"
  echo "════════ $label ════════"
  echo "  evm-tx-hash: $tx"
  cre workflow simulate policy --target staging-settings --non-interactive \
      --trigger-index 0 --evm-tx-hash "$tx" --evm-event-index 0 2>&1 \
    | grep -E "Workflow compiled|Binary hash|Nitro|not a real TEE|will not leave the TEE|Simulation Result|^\""
  echo
}

run "SCENE 1  ALLOW     500 USDC, healthy context"   0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843
run "SCENE 2  ESCALATE  5,000 USDC (over private autonomous limit)" 0x313dd7a4c4117ce70282cc9ec2efaeecdaeb35a1fc6a89f508d1eaef3c628a78
run "SCENE 3  DENY      50,000 USDC (over private escalation limit)" 0xef74c0bfaf5809d39467b3157aa314c468ff39b576c3e85505bd13447c15f9e8
run "SCENE 4  ESCALATE  500 USDC but volatility 5000bps (> private maxVolatilityBps)" 0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843 12 5000
run "SCENE 5  DENY      500 USDC but slippage 900bps (> private maxSlippageBps)" 0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843 900 150
