# ContextLock - Pinned Versions and Live Doc Verification

All values below were verified on **2026-09-06** by direct query (`npm view`, `--version`, live docs fetch,
and on-chain `codesize` probes against Sepolia). Nothing here is copied from the build bible.

## Local toolchain (verified present)

| Tool | Version | How verified |
|---|---|---|
| git | 2.51.0 | `git --version` |
| node | 22.23.1 | `node --version` |
| npm | 10.9.8 | `npm --version` |
| forge / cast / anvil | 1.2.3-stable (a813a2c) | `forge --version` |
| go | 1.24.4 darwin/arm64 | `go version` |
| docker | 28.1.1 | `docker --version` |
| jq | 1.8.1 | `jq --version` |
| python3 | 3.14.2 | `python3 --version` |

Package manager: **npm workspaces** (npm 10.9.8). `pnpm` is not installed; npm workspaces are
sufficient for this monorepo and remove a global-install prerequisite.

## Pinned npm dependencies

| Package | Latest @ 2026-09-06 | Pinned | Used by |
|---|---|---|---|
| typescript | 5.9.3 | 5.9.3 | all |
| viem | 2.56.3 | 2.56.3 | protocol, ens, broker, demo-agent |
| vitest | **3.2.7** | 3.2.7 | tests — upgraded from 3.2.4 for FND-015 |
| tsx | 4.20.6 | 4.20.6 | scripts |
| fastify | **5.12.3** | pinned | broker — upgraded from 5.6.1 for FND-015 |
| zod | see apps/broker/package.json | pinned | request validation |
| better-sqlite3 | see apps/broker/package.json | pinned | broker persistence |
| @types/node | 22.18.11 | 22.18.11 | all |

Not yet installed (later phases, placeholders only):

| Package | Latest @ 2026-09-06 | Phase |
|---|---|---|
| @chainlink/cre-sdk | 1.19.1 | Phase 4 |
| cre CLI | v1.32.0 (install.sh) | Phase 4 |
| @ledgerhq/wallet-cli | 2.1.0 | Phase 6 |
| @ledgerhq/device-management-kit | 1.9.0 | Phase 7 |
| @ledgerhq/device-signer-kit-ethereum | 1.18.0 | Phase 7 |
| @ledgerhq/context-module | 2.5.0 | Phase 7 |
| @ensdomains/ensjs | 4.3.1 | Phase 3 (viem used instead) |
| @ensdomains/ens-contracts | 1.7.0 | Phase 3 (deployment artifacts source of truth) |

## Solidity

- `solc` 0.8.28, `evm_version = "cancun"`, `optimizer = true`, `optimizer_runs = 200`.
- No external Solidity dependencies. The executor, registries and mock target are written from
  scratch so every authorization branch is reviewable without third-party abstractions.

## Live network facts (verified on-chain 2026-09-06)

- Sepolia `chainId = 11155111`; block at preflight `11647539`; gas price ~0.97 gwei.
- Base Sepolia (`84532`) reachable but **deliberately unused** — this build is Sepolia-only.

## ENSv2 Sepolia deployments (discovered, verified, and disambiguated)

**Corrected in Phase 3 — see `reports/phase-03/findings/FND-008.`** The Phase 0 preflight table
below was transcribed from the docs page. Phase 3 discovered that **three** distinct, fully
deployed, internally consistent ENSv2 Sepolia deployments exist and disagree with each other.

ContextLock uses the **docs-published set**, identified as the live public beta because it carries
the migrated ENS v1 name mirror (`test`, `ens`, `nick` all taken), whereas the repo `main`
deployment is sparse. Official documentation outranks repository code in the gauntlet's priority
order, and this is the set a judge will check.

### Set in use (all bytecode-verified on Sepolia)

| Contract | Address | codesize |
|---|---|---|
| ETHRegistry | 0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2 | 14730 |
| ETHRegistrar | 0xa88553f454b77203b0d036a05c894d555eaaa2cc | 7497 |
| RootRegistry | 0x8115186e8f2e0b0281e86ab91f0f48ba90364354 | 14730 |
| UniversalResolverV2 | 0x4a1817d13e9cf196f471725176355c1234b63c70 | 18495 |
| PublicResolverV2 | 0xe7B9A25607E02da8145E4eB1836CA539e53F11f7 | — |
| MockUSDC | 0x768f42455a2d082e23ceef7d51e5787c82d67a39 | 4309 |

MockUSDC verified live: `symbol() = "USDC"`, `decimals() = 6`, unrestricted `mint(address,uint256)`.
Registration price observed: **8.000021 MockUSDC** for one year.

### Deployments deliberately NOT used

| Set | ETHRegistry | Why not |
|---|---|---|
| repo `main` (deployedAt 2026-06-29) | 0x67b728a792e789a8978b30cf1b3b641f19354b43 | Sparse; v1 mirror absent; branch names indicate a dev redeploy |
| `sepolia-official-v1-20260525-r2` | 0xdedb92913a25abe1f7bcdd85d8a344a43b398b67 | Dated snapshot of an earlier promotion |

Codified in `packages/ens/src/deployments.ts`, including the rejected alternates, so the choice
stays auditable. ABIs are taken from the repo artifacts and were confirmed wire-compatible with
the in-use set by live calls.

### EAC roles actually granted at registration (FND-009)

Registering through `ETHRegistrar` grants the name owner `ROLE_SET_RESOLVER` and
`ROLE_SET_SUBREGISTRY` (plus admin variants and `ROLE_CAN_TRANSFER_ADMIN` admin) — but **not**
`ROLE_UNREGISTER` and **not** `ROLE_RENEW`. `unregister()` therefore reverts
`EACUnauthorizedAccountRoles` for the owner. Verified live.

## Chainlink CRE (Phase 4 - not implemented)

Confidential API confirmed unchanged from the bible:
`cre.handlerInTee(trigger, fn, tees)` · `runtime.getSecret({ id })` · `runtime.usingTheDons()` ·
AWS Nitro `us-west-2` only · simulator is not a real TEE · no logging inside the enclave.

Liquidation-protection challenge (bytecode verified, `join()` currently reverts
`"Challenge is not open"` — window opens 8 Sep):
Challenge `0x59d5B29FbA5ca865a171076BE94EbEeC5BCA1E04` ·
vETH `0x89F0DF6D4629D494D599E03505C323537C24667a` ·
vUSD `0xC96c007023Ae2a23D097D5D95d4b91D6a501Da0b`

## Ledger (Phase 6/7 - not implemented)

`wallet-cli ring` subcommands: `init | encrypt | decrypt | keys | destroy`.
Physical device required for `ring init` only; encrypt/decrypt are headless **but require network
access** (see FND-002). `WALLET_PASS` is read from the environment when no TTY is present.

## ETHOnline 2026 rules (verified)

Deadline **Sunday 13 September 2026, 12:00 PM EDT**. Up to 3 partner prizes. 2-4 minute demo
video (auto-reject outside that range). Version control required; large single commits or missing
history may disqualify. AI tooling permitted with documented attribution.

## Chainlink CRE — verified in Phase 4 (2026-09-06)

| Item | Version / value | How verified |
|---|---|---|
| CRE CLI | **v1.32.0** | `curl -sSL https://app.chain.link/cre/install.sh \| bash` |
| `@chainlink/cre-sdk` | **1.19.1** | installed from public npm |
| bun (required for TS workflows) | **1.4.2** | installer recommends ≥1.0.0 |
| Go (recommended for Go workflows) | 1.25.3 recommended; 1.24.4 present | installer warning |
| Template source | `smartcontractkit/cre-templates` (public, no auth) | cloned |

API surface verified **at runtime**, not assumed:

```
cre.handlerInTee: function      cre.handler: function
cre.capabilities: CronCapability, HTTPCapability, ConfidentialHTTPClient,
                  HTTPClient, EVMClient, SolanaClient
EVMClient:        callContract, filterLogs, balanceAt, estimateGas,
                  getTransactionByHash, getTransactionReceipt, headerByNumber,
                  logTrigger, writeReport
```

Notes discovered in use, beyond the docs:
- `EVMClient` takes the chain selector as a **bigint** positional argument in 1.19.1.
- `logTrigger` is paired with the exported `logTriggerConfig(...)` helper.
- HTTP `multiHeaders` values are typed `string[]`.

**Access (updated 2026-09-07):** `cre login` requires interactive browser SSO + 2FA and gates
`cre init`, therefore gating the official simulator too — stricter than FND-001 assumed. The
operator completed it; **BLK-001 is RESOLVED** and `CRE_MODE=simulator`. Account
`org_ENDgZRZzalm3d3So`, `Deploy Access: Not enabled`, so live deployment remains out of reach.

**EVM log trigger payload (verified in the simulator, FND-012):** `logTrigger` hands the handler a
raw protobuf `Log` — `address`, `topics[]` and `data` as `Uint8Array` — **not** a decoded event
struct. The workflow decodes it itself with viem's `decodeEventLog`. The
`hello-confidential-workflows` template uses a cron trigger and so does not demonstrate this.

**Simulator invocation:**
```
cre workflow simulate policy --target staging-settings --non-interactive \
  --trigger-index 0 --evm-tx-hash <tx> --evm-event-index <n>
```
EVM triggers require `--evm-tx-hash` and `--evm-event-index` in non-interactive mode.

**RPC note (FND-013):** the Alchemy free tier caps `eth_getLogs` to a 10-block range, and `cast
logs` reports the resulting HTTP 400 as empty output. Address events by transaction hash rather
than scanning ranges.

## Chainlink liquidation challenge — re-checked 2026-09-06

`join()` still reverts `"Challenge is not open"`. The window opens 8 Sep. Skipped per instruction;
recorded in FND-004. Not a dependency of core Phase 4.
