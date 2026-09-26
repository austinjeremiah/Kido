# Amane

**Bounded financial authority for software agents, enforced natively on Ethereum (Sepolia) and Sui (Testnet).**

> **Status: testnet prototype · not audited · testnet assets only.** Do not use with real funds.

Amane answers one question: *what is this account, or an agent acting for it, physically allowed to do?* It does not decide what an agent *should* do. That is left to the orchestrator above it, such as Kido.

## Threat model

Amane assumes the agent can be wrong, prompt-injected, stale or fully compromised, and that the executor relaying its transactions is untrusted. Under those assumptions:

- An agent key can only sign actions inside its lease. It cannot sign a lease, change policy, withdraw, or pick an arbitrary target or recipient.
- An executor or relayer can submit, delay or censor. It cannot change a signed action, broaden a lease, redirect output or take custody. Pause and revoke messages can be relayed by anyone, so one executor cannot censor them.
- A Lease Issuer key (for example the one held by Kido's backend) is bounded by its own caps, which are smaller than the Root Policy. Those caps apply to everything the issuer has issued, not to each lease separately.
- A fully compromised root controller is out of scope. It is mitigated by threshold controllers, pinned recovery destinations and code without an admin.

## Authority hierarchy

```
Action ⊆ Lease ⊆ RootPolicy ⊆ Account
```

| Object | Signed by | Binds |
|---|---|---|
| `RootPolicy` | root controllers (threshold) | per-endpoint allowed actions, adapters, assets with per-action/epoch/total caps in token base units, pinned recipients and beneficiaries, owner swap floors, recovery destinations, lease issuers and their caps, parent policy hash, activation deadline |
| `AgentLease` | a root controller or a Lease Issuer listed in the policy (never the agent) | agent key, validity window, activation deadline, subset of actions, adapters, assets, caps and recipients for each endpoint |
| `ActionIntent` | the agent | exact endpoint (chainRef + account), lease, nonce, adapter id + name + version, assets, amount, recipient, deadline, plan hash and step |
| `PauseAccount` | any one controller | pause epoch, single-use pause id, deadline |
| `UnpauseAccount` / `Withdraw` | controller threshold | the exact endpoint and the exact pause or withdrawal |

Every object is EIP-712 typed data under the domain `{name: "Amane", version: "1", chainId: 11155111}` with no `verifyingContract`. The same signature is verified on Sepolia and on Sui, and the struct fields bind the endpoint. Signatures must be 65-byte `r‖s‖v` with `v ∈ {27,28}` and low `s`, enforced on both chains. Sui's native `ecrecover` accepts the high-s twin, so Amane rejects it explicitly.

On every action, each endpoint:

1. checks pause, endpoint binding, lease status, policy version, lease window and deadline;
2. recovers the agent signature and marks the nonce as used;
3. checks the action kind, the adapter (its id, name and version, recomputed from the registry or witness) and the assets against both the lease and the policy;
4. debits the lease, root and issuer budgets **before** any funds move;
5. moves exactly the input and **measures** what was delivered: SWAP output back into the account against the effective minimum `max(agentMinOut, amountIn × ownerFloor)`, and PAY by the recipient's balance change.

Budgets are token buckets. `maxPerEpoch` is the burst capacity and refills linearly over `epochSeconds`, so spend inside any window of length W is at most `maxPerEpoch × (1 + W / epochSeconds)`, which is 2× per epoch-length window in the worst case. Limits are enforced separately on each chain endpoint, so the worst-case exposure across chains is the **sum** of the per-endpoint limits.

## Chain endpoints

| | Sepolia | Sui Testnet |
|---|---|---|
| Account | `AmaneAccount`, one non-upgradeable contract per account, with no admin | shared `amane::account::Account` object |
| Adapter dispatch | append-only `AdapterRegistry`. The id commits to the chain, kind, name, version, address and code hash. Registration refuses runtime code containing DELEGATECALL, CALLCODE, SELFDESTRUCT or SSTORE | hot-potato `ActionTicket<W, In>` (no abilities). Only the adapter that owns witness `W` can take the input, and `settle` must consume the ticket in the same PTB |
| Upgrade authority | none | package made immutable (`UpgradeCap` destroyed) |
| Deployed | [`deployments/testnet.json`](deployments/testnet.json) | same |

Adapters shipped in v1:

| Adapter | Chain | Status |
|---|---|---|
| Transfer Pay (PAY to a pinned recipient) | Sepolia (registered contract), Sui (native in core) | live |
| Swap (SWAP with owner floor) | both cores support it; only a test fixture adapter exists | Cetus CLMM / Uniswap v3 adapters not yet shipped |
| REPAY | refused by the core | disabled until an adapter can prove what it delivered |

Controller schemes: **`EVM_SECP256K1` only**, verified on both chains. ERC-1271, passkeys and Sui-native keys are not supported and are not claimed.

## Repository

```
packages/core   canonical schema, EIP-712 hashing, ids, off-chain subset checks, shared rejection codes
packages/sdk    relayers for both endpoints, signing helpers, live testnet gauntlet script
evm/            Solidity core, registry, adapters, Foundry tests (unit, adversarial, invariant)
sui/amane       Move core; sui/amane_tokens: open testnet demo tokens (AMUSD, AMSUI)
vectors/        golden vectors shared by TypeScript, Solidity and Move
deployments/    testnet deployment manifest
```

## Reproduce

Requirements: Node ≥ 22, Foundry, **sui ≥ 1.80**. Sui has shut down public JSON-RPC, so older CLIs cannot reach testnet.

```bash
npm ci && git submodule update --init
npm test                              # core + sdk (vitest), evm (forge), sui (sui move test; SUI=/path/to/sui to override)
npm run vectors                       # regenerate golden vectors; the diff must be empty
```

Deploy (testnet only):

```bash
DEPLOYER_PRIVATE_KEY=... forge script evm/script/DeployInfra.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
SUI=/path/to/sui scripts/deploy-sui.sh
```

Live two-chain gauntlet: it deploys fresh endpoints, installs one policy and one lease on both, executes allowed actions, runs the attack set, then pauses, revokes and recovers.

```bash
cd packages/sdk
AMANE_DEMO_KEYS=/somewhere/outside/the/repo/keys.json npx tsx scripts/testnet-gauntlet.ts --print-sui-relayer   # fund this address with testnet SUI
AMANE_DEMO_KEYS=... AMANE_EVM_RELAYER_KEY=... SEPOLIA_RPC_URL=... npx tsx scripts/testnet-gauntlet.ts
```

## Known limitations

- **Not audited.** Immutable code means bugs are permanent. A fix ships as a new version, and accounts move to it explicitly.
- Cross-chain revocation is not atomic. Between signing and landing on each chain, an agent key can still spend the remaining per-endpoint budget. Keep leases short and budgets small. The UI must not show "revoked" until every endpoint confirms.
- `chainRef` on Sui is asserted by the creator, because Move cannot read the chain id. Clients check the live chain identifier before signing and fail closed if it changes (testnet resets). The account object id in every struct prevents cross-endpoint replay.
- The Sui adapter id is derived from the witness type name, which an upgrade does not change. Adapter packages must be published immutable, and this is checked off-chain.
- Upstream protocols (Cetus, Aave, Uniswap) are mutable. An adapter pins its bindings and fails closed on drift, with funds left in the vault.
- A single RPC can lie about receipts. The SDK can land rejected actions on both chains so that every reported rejection has an on-chain receipt, but a client that trusts one RPC cannot detect false receipts.
- A price floor exists only in `TESTNET_FIXED` mode: the owner sets it per pair in token units, for project-owned pools. Oracle modes are future work.
