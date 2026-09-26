#!/usr/bin/env bash
# Privilege boundary audit for Kido. The model-facing agents (@kido/agents) are untrusted: they must
# not be able to name, read or use a signing key, and privileged keys may be read only by
# operator-run scripts. Checks inspect source and the dependency graph, not assertions.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
say(){ printf '%s\n' "$*"; }

PRIVILEGED='FUNDER_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY|AMANE_EVM_RELAYER_KEY|KIDO_SUI_SIGNER_KEY|KIDO_DEMO_KEYS|AMANE_DEMO_KEYS|CRE_ETH_PRIVATE_KEY'
AGENT_SRC='packages/kido-agents/src'

say "=== Kido privilege boundary audit ==="

say "--- [1] agent source names no privileged credential ---"
if git grep -lE "$PRIVILEGED" -- "$AGENT_SRC" | grep -q .; then say "FAIL agent source names a privileged credential"; FAIL=1
else say "OK  no privileged credential name in $AGENT_SRC"; fi

say "--- [2] agent cannot construct a signer ---"
if git grep -lE "privateKeyToAccount|mnemonicToAccount|fromSecretKey|Ed25519Keypair|signTypedData|signTransaction|signPersonalMessage" -- "$AGENT_SRC" | grep -q .; then
  say "FAIL agent source can construct or use a signer"; FAIL=1
else say "OK  agent has no signing capability"; fi

say "--- [3] agent reads no environment secret ---"
if git grep -nE "process\.env" -- "$AGENT_SRC" | grep -vE "process\.env\.(OPENAI_MODEL|OPENAI_API_KEY|KIDO_MODEL|KIDO_OPENAI_TRACING|NODE_ENV)" | grep -q .; then
  say "FAIL agent reads process.env beyond model configuration"; FAIL=1
else say "OK  agent reads only model configuration from the environment"; fi

say "--- [4] agent dependency graph cannot reach authority or keys ---"
DEPS=$(node -e "const p=require('./packages/kido-agents/package.json');console.log(Object.keys({...p.dependencies,...p.devDependencies}).join(' '))")
say "    declared deps: ${DEPS:-<none>}"
for forbidden in "@kido/amane-bridge" "@amane/" "@kido/foundry" "@mysten/sui" "viem"; do
  case " $DEPS " in *"$forbidden"*) say "FAIL agent depends on $forbidden"; FAIL=1;; esac
done
if git grep -nE "from ['\"](@kido/(amane-bridge|foundry)|@amane/|viem/accounts|@mysten/sui/keypairs)" -- "$AGENT_SRC" | grep -q .; then
  say "FAIL agent imports an authority or key module"; FAIL=1
fi
[ $FAIL -eq 0 ] && say "OK  agent depends on nothing privileged"

say "--- [5] privileged keys are READ only by operator-run scripts ---"
READERS_ALLOWED='^(scripts/|packages/kido-eval/src/run\.ts$|.*/test/|.*\.test\.ts$)'
VIOL=0
for f in $(git grep -lE "$PRIVILEGED" -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.sh' | grep -vE "$READERS_ALLOWED"); do
  body=$(sed -e 's|/\*.*\*/||g' -e 's|//.*$||' -e 's|^[[:space:]]*[*#>].*$||' "$f")
  if printf '%s' "$body" | grep -qE "process\.env\.($PRIVILEGED)|process\.env\[[\"']($PRIVILEGED)[\"']\]|need\([\"']($PRIVILEGED)[\"']\)|\\\$\{?($PRIVILEGED)\}?"; then
    say "FAIL $f reads a privileged key"; VIOL=1; FAIL=1
  fi
done
[ $VIOL -eq 0 ] && say "OK  only operator scripts read privileged keys"

say ""
if [ $FAIL -eq 0 ]; then say "PRIVILEGE AUDIT: CLEAN"; exit 0; else say "PRIVILEGE AUDIT: FAILED"; exit 1; fi
