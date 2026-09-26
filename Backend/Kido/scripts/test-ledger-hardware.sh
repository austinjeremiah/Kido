#!/usr/bin/env bash
# P9.4 — hardware-only Ledger tests. Fails loudly when no device is present.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "══ Ledger HARDWARE test suite ══"
echo
if [ "${CONTEXTLOCK_KEYRING_READY:-}" != "1" ]; then
  cat <<'MSG'
BLK-002: physical Ledger required.

These tests are BLOCKED, not skipped-and-passed. Nothing here can be satisfied by software:

  LED-001      wallet-cli ring init          (device confirmation)
  LED-002      encrypt/decrypt round-trip     (a provisioned ring)
  LED-H03      physical approval of ESCALATE  (device)
  LED-H04      physical on-device rejection   (device)
  LED-H15      device disconnected mid-flow   (device)
  LED-H16      Ledger transport error         (device)
  LED-H20-PHYS Clear Signing render           (device)

To run them:
  1. connect and unlock a supported Ledger over USB
  2. export WALLET_PASS in YOUR shell (never pasted into an agent, never committed)
  3. export LEDGER_WALLET_CLI="$(pwd)/node_modules/@ledgerhq/wallet-cli/bin/wallet-cli"
  4. wallet-cli ring init --name contextlock-dev
  5. export CONTEXTLOCK_KEYRING_READY=1 && npm run test:ledger:hardware

Full instructions: reports/phase-06/blockers/BLK-002-no-physical-ledger-device.md
MSG
  exit 1
fi

echo "CONTEXTLOCK_KEYRING_READY=1 — running hardware tests"
cd packages/ledger && npx vitest run
