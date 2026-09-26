#!/usr/bin/env bash
# Publishes an Amane Sui core release to the active Sui environment and freezes it.
# Requires sui >= 1.80 (JSON-RPC is shut down; older CLIs cannot reach testnet). Override with SUI=.
set -euo pipefail
SUI="${SUI:-sui}"
cd "$(dirname "$0")/../sui/amane"
rm -f Published.toml
out="$("$SUI" client publish --gas-budget 500000000 --json)"
pkg="$(jq -r '.objectChanges[] | select(.type=="published") | .packageId' <<<"$out")"
cap="$(jq -r '.objectChanges[] | select(.objectType=="0x2::package::UpgradeCap") | .objectId' <<<"$out")"
echo "published $pkg ($(jq -r .digest <<<"$out"))"
"$SUI" client call --package 0x2 --module package --function make_immutable --args "$cap" --gas-budget 50000000 --json \
  | jq -r '"frozen: \(.effects.status.status) \(.digest)"'
rm -f Published.toml
echo "record packageId=$pkg in deployments/testnet.json"
