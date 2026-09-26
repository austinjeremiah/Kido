# CRE Execution Mode — authoritative baseline

Machine-readable status. Any document, script or UI that states the CRE mode must agree with this
file. If they ever disagree, this file wins and the other is a bug.

```
CRE_MODE=official-cli-simulator

REAL_TEE_EXECUTION=NO
OFFICIAL_CLI_SIMULATION=YES
LIVE_CRE_DEPLOYMENT=NO
```

## What each line means

| Flag | Value | Basis |
|---|---|---|
| `OFFICIAL_CLI_SIMULATION` | **YES** | `cre workflow simulate` (CLI v1.32.0) executed the WASM-compiled ContextLock workflow across 5 scenes, each triggered by a real `CapabilityRequested` transaction on Sepolia. Binary hash `800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0`. |
| `REAL_TEE_EXECUTION` | **NO** | Nothing ran inside an AWS Nitro enclave. The simulator itself prints *"The simulator is not a real TEE, and is meant to debug."* The TEE **handler** is registered and the simulator announces the constraint (*"AWS Nitro in us-west-2"*), but registration is not execution. |
| `LIVE_CRE_DEPLOYMENT` | **NO** | `cre whoami` reports `Deploy Access: Not enabled`. Confidential Workflows live access is additionally invite-only private beta (FND-001). No workflow has been deployed to the CRE network. |

## Consequences for claims

Permitted: *"registered a confidential TEE handler and executed it with the official Chainlink CRE
CLI simulator, triggered by real Sepolia events."*

Not permitted: *"ran in a TEE"*, *"ran in Nitro"*, *"deployed to CRE"*, *"DON-signed report"*,
*"Vault DON released our secrets"*.

## Related records

- `reports/phase-04/CRE_MODE.md` — full determination, including the superseded blocked analysis
- `reports/phase-04/blockers/BLK-001-cre-cli-authentication.md` — RESOLVED
- `reports/phase-04/findings/FND-001-*` — Confidential Workflows private beta, ACCEPTED_RISK
- `reports/phase-04/findings/FND-012-*` — EVM log trigger delivers raw protobuf `Log`
- `reports/phase-04/findings/FND-013-*` — RPC `eth_getLogs` 10-block cap
- `deployments/sepolia-p4.json` → `creMode: "simulator"`
