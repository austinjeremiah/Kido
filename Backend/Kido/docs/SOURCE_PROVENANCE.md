# Source provenance (P10.8)

What in this repository is original, what is third-party, and where the third-party parts came
from. Written so a reviewer can tell at a glance which lines this project is responsible for.

---

## 1. All original work, written for ETHOnline 2026

Everything under `contracts/`, `packages/`, `apps/`, `workflows/`, `scripts/`, `docs/` and
`reports/` was written during this event, against the human-authored specification in `specs/`. No
prior project was forked, and no code was copied from another submission.

Git history is intact and unsquashed — one commit per coherent unit of work, each with its test
evidence. `git log` is part of the evidence.

## 2. Third-party code, vendored

| What | Source | Where | Why |
|---|---|---|---|
| `forge-std` | [foundry-rs/forge-std](https://github.com/foundry-rs/forge-std) (MIT/Apache-2.0) | `contracts/lib/` — **not committed**, restored with `forge install` | Foundry's standard test library |

`contracts/lib/` is gitignored. `docs/CLEAN_INSTALL.md` gives the exact restore command.

**No OpenZeppelin, no Solady, no external Solidity library is used.** The contracts have zero
inherited implementation. This is deliberate: a reference monitor whose validation order depends on
an inherited modifier is harder to audit, and every one of the nine ordered validation groups in
`ContextLockExecutor.sol` is visible in one file.

The EIP-712 domain separator and typed-data hashing are implemented directly from
[EIP-712](https://eips.ethereum.org/EIPS/eip-712) rather than inherited.

## 3. Third-party runtime dependencies

| Package | Version | Used by | Role |
|---|---|---|---|
| `viem` | 2.56.3 | protocol, adapters, ens, broker, demo-agent | Ethereum client, ABI encoding, EIP-712 |
| `zod` | 4.1.12 | adapters, broker | Input schema validation |
| `fastify` | 5.12.3 | broker | HTTP API |
| `better-sqlite3` | 12.4.1 | broker | Local request state |
| `@chainlink/cre-sdk` | 1.19.1 | CRE workflow | Confidential workflow SDK |
| `@ledgerhq/wallet-cli` | — | ledger (optional) | Key Ring provisioning |

`packages/policy` and `packages/ledger` declare **zero** runtime dependencies. The policy decision
function and the secret-broker boundary depend on nothing but the language, so their behaviour
cannot change underneath the project.

`apps/demo-agent` declares exactly one dependency (`viem`) and is enforced by
`scripts/privilege-audit.sh` check [4]: the untrusted agent must not be able to reach a signer, a
database, or the Ledger package through its dependency graph.

`fastify` and `vitest` were both upgraded during Phase 8 in response to real advisories — a
body-schema-validation bypass and a critical vitest issue (FND-015). `npm audit` reports **0
vulnerabilities**.

## 4. Specifications and standards implemented from the spec text

| Standard | Where | Note |
|---|---|---|
| **EIP-712** | `contracts/src/ContextLockTypes.sol`, `packages/protocol/src/capability.ts` | Implemented **twice, independently** — Solidity and TypeScript — with 16 golden vectors asserting they agree. A bug would have to be made identically in two languages. |
| **ERC-7730** (Clear Signing) | `packages/ledger/erc7730/contextlock-approval.json` | Descriptor authored against the current schema. **Never rendered on a device** — BLK-002. |
| **ENSIP-26** (agent text records) | referenced in `packages/ens/` | Draft status noted in `docs/REFERENCE_MANIFEST.md`. |

## 5. Sponsor interfaces

Every sponsor interface was read from **current official documentation** during the build and, where
on-chain, confirmed by bytecode probe before use. Where documentation and reality disagreed, a
documentation-drift finding was filed citing the exact difference **before** any code changed:

| Finding | Drift |
|---|---|
| FND-001 | Chainlink Confidential Workflows access is invite-only private beta |
| FND-002 | Ledger Key Ring network-dependency documentation (**still open**) |
| FND-004 | Chainlink challenge configuration dated/closed (**still open**) |
| FND-008 | Three live ENSv2 Sepolia deployments; published docs do not disambiguate |
| FND-011 | `npx wallet-cli` resolves to an unrelated third-party package |
| FND-012 | CRE EVM log trigger delivers a raw protobuf `Log`, not a decoded struct |
| FND-013 | RPC `eth_getLogs` 10-block cap returns empty rather than erroring |

Full annotated bibliography with per-source verification status: `docs/REFERENCE_MANIFEST.md`.
Source manifest: `SOURCES_AND_DOCS.md`.

## 6. Deployed addresses used, not authored

| Contract | Address | Origin |
|---|---|---|
| ENSv2 `ETHRegistry` | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | ENS Sepolia deployment |
| ENSv2 `ETHRegistrar` | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | ENS Sepolia deployment |
| `PublicResolverV2` | `0xe7B9A25607E02da8145E4eB1836CA539e53F11f7` | ENS Sepolia deployment |
| `UniversalResolverV2` | `0x4a1817d13e9cf196f471725176355c1234b63c70` | ENS Sepolia deployment |
| `MockUSDC` (registration fee) | `0x768f42455a2d082e23ceef7d51e5787c82d67a39` | ENS Sepolia deployment |

The deployment set was selected by probing migrated-name occupancy after FND-008. The rejected
alternates are retained in `packages/ens/src/deployments.ts` rather than deleted, because the next
implementer faces the same ambiguity.

## 7. AI authorship

Disclosed in full in `AI_USAGE.md`, including the specific cases where the agent's first answer was
wrong and evidence overrode it.

## 8. License

MIT (`LICENSE`), with an explicit note that this is unaudited testnet software.
