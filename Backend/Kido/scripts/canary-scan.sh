#!/usr/bin/env bash
# CONF-001: prove no confidential value escapes the private-input boundary (see canary-scan.ts).
set -uo pipefail
cd "$(dirname "$0")/.."
npx tsx scripts/canary-scan.ts
