#!/usr/bin/env bash
# Put a Studio credential under the Ledger Key Ring.
#
#   scripts/studio/ring-secret.sh THEGRAPH_API_KEY        # value read from stdin, or from $THEGRAPH_API_KEY
#
# Writes secrets/<name>.ring (gitignored) with `wallet-cli ring encrypt`. From then on the Studio
# backend decrypts it through the ring when it needs it (apps/studio/src/secrets.ts) and the
# plaintext line can be removed from .env. Nothing here prints the value.
#
# Prerequisites, once, on a machine with the Ledger plugged in:
#   1. store the ring password in your OS keychain (never typed into an agent):
#        security add-generic-password -a default -s ledger-wallet-cli -w        # macOS
#   2. export WALLET_PASS from it, then create this machine's ring membership (device tap):
#        export WALLET_PASS="$(security find-generic-password -a default -s ledger-wallet-cli -w)"
#        npx --package=@ledgerhq/wallet-cli wallet-cli ring init --name contextlock-studio
# Later runs of the Studio need only WALLET_PASS in the environment and network access.
set -euo pipefail
cd "$(dirname "$0")/../.."

name="${1:-}"
[[ "$name" =~ ^[A-Z][A-Z0-9_]+$ ]] || { echo "usage: $0 SECRET_NAME   (e.g. THEGRAPH_API_KEY)" >&2; exit 2; }
key="${STUDIO_RING_KEY:-contextlock-studio}"
dir="${STUDIO_SECRETS_DIR:-secrets}"
out="$dir/$(echo "$name" | tr 'A-Z_' 'a-z-').ring"
cli="${LEDGER_WALLET_CLI:-node_modules/@ledgerhq/wallet-cli/bin/wallet-cli}"

[[ -x "$cli" || -f "$cli" ]] || { echo "wallet-cli not found at $cli — npm i -D @ledgerhq/wallet-cli, or set LEDGER_WALLET_CLI" >&2; exit 2; }
[[ -n "${WALLET_PASS:-}" ]] || { echo "WALLET_PASS is not in the environment (export it from your OS keychain first)" >&2; exit 2; }
mkdir -p "$dir"

# The value comes from stdin when piped, otherwise from the environment variable of the same name.
if [ -t 0 ]; then
  [[ -n "${!name:-}" ]] || { echo "pipe the value on stdin, or export $name" >&2; exit 2; }
  printf '%s' "${!name}" | "$cli" ring encrypt --key "$key" --out "$out" >/dev/null
else
  "$cli" ring encrypt --key "$key" --out "$out" </dev/stdin >/dev/null
fi

[[ -s "$out" ]] || { echo "ring encrypt produced no ciphertext (ring not initialised, wrong password, or no network)" >&2; exit 1; }
echo "✓ $name is now held by the Ledger Key Ring: $out (key $key)"
echo "  Remove the plaintext $name= line from .env and restart the Studio API."
