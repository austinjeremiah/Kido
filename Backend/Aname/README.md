# Amane

**Bounded financial authority for software agents — enforced on-chain, natively, on Ethereum and Sui.**

Amane is an SDK and a pair of on-chain cores (Solidity and Move) that let an account delegate *narrow, revocable, budgeted* spending power to an automated agent. The agent can sign actions; the chain decides whether each one is inside the authority the owner granted. Nothing the agent, its model, its relayer or a bridge says can widen that authority.

> **Status:** testnet prototype (Ethereum Sepolia, Sui Testnet). **Not audited.** Use testnet assets only.

```
Action  ⊆  Lease  ⊆  RootPolicy  ⊆  Account
agent      issuer    owner (threshold)
```

---

## Contents

- [Why Amane](#why-amane)
- [Features](#features)
- [Architecture](#architecture)
  - [Authority model](#authority-model)
  - [Enforcement pipeline](#enforcement-pipeline)
  - [Adapters](#adapters)
  - [Cross-chain: BRIDGE, reservations, quarantine](#cross-chain-bridge-reservations-quarantine)
  - [Signatures and hashing](#signatures-and-hashing)
- [Packages](#packages)
- [Installation](#installation)
- [Quick start](#quick-start)
- [SDK reference](#sdk-reference)
- [Deployments](#deployments)
- [Live testnet proof](#live-testnet-proof)
- [Threat model](#threat-model)
- [Testing](#testing)
- [Deploying your own](#deploying-your-own)
- [Known limitations](#known-limitations)
- [Repository layout](#repository-layout)
- [License](#license)

---

## Why Amane

Agents that move money fail in predictable ways: a prompt injection, a stale price, a bug in a planner, a compromised hot key, a malicious relayer, a bridge message that says "and now send it to me". Off-chain guardrails only help while the off-chain system is honest.

Amane moves the guardrail into the account itself. The owner signs a **root policy** once. Agents receive short-lived **leases** carved out of that policy. Every **action** an agent signs is checked by the account contract (EVM) or account object (Sui) against the lease and the policy **before any value moves**, and the delivered result is **measured**, not trusted.

Amane answers exactly one question — *what is this agent physically allowed to do?* — and leaves *what it should do* to whatever system sits above it.

## Features

- **Owner-signed root policy** per account, per chain endpoint: allowed action kinds, adapters (by immutable id), assets with per-action / per-epoch / total caps, pinned recipients and beneficiaries, owner price floors, recovery destinations, delegated lease issuers and their caps.
- **Agent leases** that are strict subsets of the policy, with validity windows and their own budgets. Issuers are bounded by aggregate caps across everything they issue.
- **Typed agent actions** — `SWAP`, `PAY`, `REPAY`, `BRIDGE` — each bound to an exact endpoint, lease, nonce, adapter, asset, amount, recipient, deadline and plan step.
- **Measured settlement**: swap output is measured into the account against `max(agentMin, amountIn × ownerFloor)`; payments by recipient balance change; debt repayment by the beneficiary's debt reduction; bridge sends by exact balance delta with zero adapter residue.
- **Token-bucket budgets** in token base units, debited only after every authorization check has passed, before funds move.
- **Pause / unpause / revoke / withdraw**: any one controller can pause (relayable by anyone, so it cannot be censored); lifting a pause, withdrawing and policy changes need the controller threshold; withdrawals only to pinned recovery destinations.
- **Immutable, admin-free cores and adapters**: one non-upgradeable contract per EVM account; Sui packages published and frozen.
- **Cross-chain authority** (EVM core v3, Sui core v5): an agent-signed `BRIDGE` commits to a destination spec; arrivals are **reserved** for that one intent on the destination chain and can only be spent by the action it committed to. Undeliverable arrivals go to **quarantine** for root recovery.
- **Wormhole Token Bridge transport** on both chains, carrying only a 64-byte commitment — never an executable payload.
- **One signature, both chains**: EIP-712 typed data verified identically in Solidity and Move, with golden vectors shared across TypeScript, Solidity and Move.
- **Honest outcomes**: the SDK distinguishes `EXECUTED`, `REJECTED_BY_AMANE` (with a stable numeric code), `NONCE_CONSUMED` and `OPERATIONAL_FAILURE`, and can land a rejected action on-chain so every reported rejection has a receipt.

---

## Architecture

```
                         ┌──────────────────────────────────────────┐
                         │  Orchestrator / agent runtime (yours)    │
                         │  decides WHAT to do; holds no authority   │
                         └──────────────┬───────────────────────────┘
                                        │ agent-signed ActionIntent (EIP-712)
                                        ▼
                         ┌──────────────────────────────────────────┐
                         │  @amane/sdk  — relayer / builder          │
                         │  simulate → submit → classify outcome     │
                         │  (untrusted: can delay, cannot widen)     │
                         └───────┬───────────────────────┬──────────┘
                                 │                       │
             ┌───────────────────▼─────┐       ┌─────────▼──────────────────┐
             │ Ethereum (Solidity)      │       │ Sui (Move)                  │
             │ AmaneAccount (per acct)  │       │ amane::account::Account     │
             │  └ AmaneAccountExt       │       │  (shared object, vault Bag) │
             │ AdapterRegistry          │       │ ActionTicket / BridgeTicket │
             │  (append-only, codehash) │       │  (hot potatoes, witness-    │
             │                          │       │   bound adapters)           │
             └───────┬──────────────────┘       └──────────┬─────────────────┘
                     │ exact input, measured output          │
             ┌───────▼──────────┐                   ┌────────▼─────────┐
             │ Adapters          │                   │ Adapters          │
             │ Uniswap v3 swap   │                   │ Transfer Pay      │
             │ Aave v3 repay     │                   │ Cetus CLMM swap   │
             │ Transfer pay      │                   │ Wormhole bridge   │
             │ Wormhole bridge   │◄─── Wormhole ────►│                   │
             └───────────────────┘   Token Bridge    └───────────────────┘
```

### Authority model

| Object | Signed by | What it binds |
|---|---|---|
| `RootPolicy` | root controllers (threshold) | per chain endpoint: allowed action kinds; adapters `(id, name, version)`; assets with `maxPerAction / maxPerEpoch / maxTotal`; pinned recipients and beneficiaries (with labels); owner swap floors; recovery destinations; lease issuers with aggregate caps; parent policy hash; activation deadline |
| `AgentLease` | a root controller, or a lease issuer listed in the policy — never the agent | agent key; validity window; activation deadline; subset of kinds, adapters, assets and caps, recipients and beneficiaries per endpoint |
| `ActionIntent` | the agent | account id, chain ref, endpoint, policy version, lease, nonce, kind, adapter id/name/version, asset in/out, amount, min out, recipient + label, deadline, plan hash, plan step |
| `PauseAccount` | any one controller | pause epoch, single-use pause id, deadline |
| `UnpauseAccount` | controller threshold | the exact pause it lifts |
| `RevokeLease` | a controller, or the lease's issuer | lease id |
| `Withdraw` | controller threshold | asset, amount, pinned recovery destination, op nonce, deadline |

A single logical account can have endpoints on several chains. The same signed policy and lease are installed on each endpoint; each endpoint enforces only the entries that name it. Limits are per endpoint, so worst-case exposure across chains is the **sum** of per-endpoint limits.

### Enforcement pipeline

Every agent action goes through the same ordered checks on-chain:

1. **Liveness** — not paused; action bound to this account id, chain ref and endpoint address/object.
2. **Lease** — active, same policy version, inside its validity window; action deadline not passed.
3. **Signature** — agent signature recovers to the lease's agent; nonce unused (then marked used).
4. **Kind / adapter / asset** — kind allowed by lease and policy; adapter id allowed by both and re-derived from the registry (EVM: address + code hash) or witness type (Sui); name and version match; asset allowed.
5. **Recipient** — for `PAY` / `BRIDGE`, recipient pinned in lease and policy with the policy's label; for `REPAY`, beneficiary pinned; for `SWAP`, output must return to the account.
6. **Budgets** — lease, root and issuer token buckets debited (only now, so rejections name the real reason).
7. **Execution and measurement** — exact input moved; output, delivery or debt reduction measured by the core against the effective minimum.

Budgets are token buckets: `maxPerEpoch` is burst capacity, refilled linearly over `epochSeconds`, so spend inside any window of length *W* is at most `maxPerEpoch × (1 + W / epochSeconds)`.

### Adapters

Adapters are the only way value leaves an account for an action. They are immutable, admin-free, and identified by an id that commits to what they are:

- **EVM** — `AdapterRegistry` is append-only. The id commits to chain, action kind, name, version, address and runtime code hash. Registration refuses code containing `DELEGATECALL`, `CALLCODE`, `SELFDESTRUCT` or `SSTORE`. The account re-checks the code hash on every use.
- **Sui** — the id commits to chain, kind, name, version and the adapter's witness type (which embeds its package id). The core hands the exact input to an `ActionTicket<W, In>` / `BridgeTicket<W, In>` hot potato that only the adapter owning witness `W` can open, and that must be settled in the same transaction.

| Adapter | Chain | Kind | Guarantees |
|---|---|---|---|
| Transfer Pay | Ethereum, Sui (core-native) | `PAY` | recipient pinned; delivery exact |
| Uniswap v3 Swap | Ethereum | `SWAP` | pinned pool and fee; output to account; core-measured ≥ floor |
| Aave v3 Repay | Ethereum | `REPAY` | pinned beneficiary; core measures variable-debt reduction per unit spent |
| Cetus CLMM Swap / Pinned Swap | Sui | `SWAP` | direct CLMM flash swap; pinned pool (pinned variant); core-measured ≥ floor |
| Wormhole Bridge | Ethereum, Sui | `BRIDGE` | pinned peer adapter; payload = `intent ‖ destination`; exact amount, no residue |

There is no generic "target + calldata" adapter, and none may be added.

### Cross-chain: BRIDGE, reservations, quarantine

A bridge moves messages and assets; **it never decides what may happen on arrival**. Amane splits a cross-chain move into two independently authorized legs:

```
 source endpoint                                   destination endpoint
 ───────────────                                   ────────────────────
 agent signs BRIDGE ActionIntent                   transport delivers funds + payload
   recipient = destination endpoint (pinned)         (intent ‖ destination endpoint)
   planHash  = hash(DestSpec)            ──────►   account re-verifies:
 core: lease, budget, pinned recipient,             • source intent signed by the lease's agent
       exact amount out                             • BRIDGE to *this* endpoint
 adapter: sends amount with                         • planHash == hash(DestSpec presented)
          payload = intent ‖ destination            • payload intent == digest(source intent)
                                                    • DestSpec kind / adapter / recipient /
                                                      asset allowed here; arrival ≥ minimum;
                                                      before deadline; intent never used
                                                   → RESERVED for that intent only
```

`DestSpec = { actionKind, adapterId, recipient, recipientLabel, asset, minArrival, deadline }` is hashed identically in Solidity, Move and TypeScript:

```
keccak256(abi.encode(keccak256("AMANE_DEST_SPEC_V1"), actionKind, adapterId, recipient,
                     keccak256(recipientLabel), asset, minArrival, deadline))
```

Lifecycle of arrived funds:

```
AVAILABLE ──► RESERVED_FOR_INTENT ──► SPENT            (executeReserved / pay_reserved / authorize_bridge_reserved)
                     │
                     └─ deadline passes ──► QUARANTINED ──► withdrawn by root threshold to a pinned recovery destination
arrival whose destination can no longer run ─────────► QUARANTINED
```

- **Reservations** can only be spent by an action whose lease, kind, adapter, recipient and asset match the reservation, up to the amount that arrived. Ordinary actions — even under the same lease — cannot spend reserved or quarantined funds.
- **Round trips**: a reserved `BRIDGE` commits to its own next destination in `planHash`, so funds can go out and come back under the same guarantees.
- **Recovery path** (`recoverArrival` / `redeem_to_recovery`): accepted only once the committed destination can no longer execute (deadline passed, lease expired or revoked). Before that it is refused, so nobody can divert a deliverable arrival.
- **Root recovery** (`withdraw`) may take available and quarantined funds, never a live reservation.

### Signatures and hashing

All messages are EIP-712 typed data under the domain `{ name: "Amane", version: "1", chainId: 11155111 }` with no `verifyingContract`. Struct fields bind the endpoint, so the same signature is valid on Ethereum and Sui without being replayable across endpoints. Signatures are 65-byte `r‖s‖v` with `v ∈ {27, 28}` and low `s`, enforced on both chains (Sui's `ecrecover` accepts the high-s twin, so Amane rejects it explicitly). Controller scheme: `EVM_SECP256K1` only.

---

## Packages

| Package | Description |
|---|---|
| `@amane/core` | Canonical schema and types, EIP-712 hashing, ids (`evmAdapterId`, `suiAdapterId`, `suiAssetId`, chain refs), off-chain subset checks (`assertPolicyWellFormed`, `assertLeaseIsSubset`, `assertActionIsSubset`), `DestSpec` hashing, shared numeric rejection codes. |
| `@amane/sdk` | Relayers for both chains (`AmaneEvmEndpoint`, `AmaneSuiEndpoint`), signing helpers, outcome classification, compiled EVM artifacts, deployment-manifest loader. |
| `evm/` | Solidity cores (`AmaneAccount`, `AmaneAccountExt`, `AdapterRegistry`) and adapters, with Foundry unit, adversarial and invariant suites. |
| `sui/amane` | Move core (account, EIP-712, secp256k1 recovery). |
| `sui/amane_cetus`, `sui/amane_cetus_pinned`, `sui/amane_wormhole` | Sui adapters. |
| `sui/amane_tokens` | Open, testnet-only demo tokens (AMUSD, AMSUI). |

## Installation

Requirements: Node ≥ 22, Foundry, `sui` CLI ≥ 1.80 (older CLIs cannot reach testnet: public JSON-RPC is shut down).

```bash
git clone https://github.com/Kaushikh76/Amane.git && cd Amane
npm ci
git submodule update --init
npm run build
```

Use the packages from your project through a workspace or file dependency:

```json
{ "dependencies": { "@amane/core": "file:../Amane/packages/core", "@amane/sdk": "file:../Amane/packages/sdk" } }
```

## Quick start

### 1. Define authority (owner side)

```ts
import { ActionKind, AuthMode, PriceMode, ZERO32, actionMask, addressToBytes32, evmAssetId, type RootPolicy, type AgentLease } from '@amane/core';
import { signThreshold, signAmane } from '@amane/sdk';

const policy: RootPolicy = {
  accountId, policyVersion: 1n, parentPolicyHash: ZERO32,
  allowedActions: actionMask(ActionKind.PAY), priceMode: PriceMode.TESTNET_FIXED,
  maxLeaseLifetime: 86_400n, activateBefore: now + 900n,
  endpoints: [{
    chainRef, account: addressToBytes32(accountAddress), epochSeconds: 3600n,
    adapters: [{ adapterId: payAdapterId, adapterName: 'Transfer Pay', adapterVersion: 1 }],
    assets: [{ assetId: evmAssetId(usdc), maxPerAction: 50_000000n, maxPerEpoch: 100_000000n, maxTotal: 300_000000n }],
    recipients: [{ recipientId: addressToBytes32(supplier), label: 'Supplier' }],
    beneficiaries: [], swapFloors: [],
    recoveryDestinations: [{ recipientId: addressToBytes32(coldWallet), label: 'Cold storage' }],
  }],
  leaseIssuers: [],
};
const policySigs = await signThreshold([controllerA, controllerB], 'RootPolicy', policy);

const lease: AgentLease = {
  accountId, policyVersion: 1n, leaseId, agent: agent.address, issuer: controllerA.address,
  validAfter: now, expiresAt: now + 3600n, activateBefore: now + 900n,
  allowedActions: actionMask(ActionKind.PAY), authMode: AuthMode.AGENT_SIGNED,
  endpoints: [{ chainRef, account: addressToBytes32(accountAddress), adapters: [payAdapterId],
    assets: [{ assetId: evmAssetId(usdc), maxPerAction: 25_000000n, maxPerEpoch: 50_000000n, maxTotal: 100_000000n }],
    recipients: [addressToBytes32(supplier)], beneficiaries: [] }],
};
const leaseSig = await signAmane(controllerA, 'AgentLease', lease);
```

### 2. Deploy and configure an endpoint (anyone can relay)

```ts
import { AmaneEvmEndpoint } from '@amane/sdk';

const { endpoint } = await AmaneEvmEndpoint.deploy({
  publicClient, relayer, accountId, controllers: [controllerA.address, controllerB.address], threshold: 2,
  registry: manifest.evm.adapterRegistry, ext: manifest.evm.accountExt,
});
await endpoint.installPolicy(policy, policySigs);
await endpoint.activateLease(lease, leaseSig);
```

### 3. Act (agent side)

```ts
const intent = { accountId, chainRef, account: endpoint.account32, policyVersion: 1n, leaseId, nonce: 1n,
  actionKind: ActionKind.PAY, adapterId: payAdapterId, adapterName: 'Transfer Pay', adapterVersion: 1,
  assetIn: evmAssetId(usdc), assetOut: evmAssetId(usdc), amountIn: 10_000000n, minAmountOut: 0n,
  recipient: addressToBytes32(supplier), recipientLabel: 'Supplier',
  deadline: now + 300n, planHash, planStep: 0 };

const outcome = await endpoint.executeAction(intent, await signAmane(agent, 'ActionIntent', intent));
switch (outcome.kind) {
  case 'EXECUTED':           /* outcome.tx */ break;
  case 'REJECTED_BY_AMANE':  /* outcome.code, e.g. AMANE_BUDGET_PER_ACTION */ break;
  case 'NONCE_CONSUMED':     /* settle from chain events; never retry blindly */ break;
  case 'OPERATIONAL_FAILURE':/* RPC, gas, funding */ break;
}
```

On Sui the flow is the same with `AmaneSuiEndpoint.create(...)`, `installPolicy`, `activateLease`, and `pay` / `swapCetus` / `bridgeOutWormhole`.

### 4. Cross-chain (Sui → Ethereum, reserved on arrival)

```ts
import { destSpecHash, amaneDigest } from '@amane/core';

// What may happen on arrival, committed by the source intent.
const dest = { actionKind: ActionKind.BRIDGE, adapterId: evmWormholeAdapterId, recipient: suiAccount32,
  recipientLabel: 'Sui endpoint', asset: evmAssetId(wrappedToken), minArrival: 20_000000n, deadline };
const bridge = { ...baseSuiIntent, actionKind: ActionKind.BRIDGE, adapterId: suiWormholeAdapterId,
  adapterName: 'Wormhole Bridge', amountIn: 20_000000n, recipient: evmAccount32,
  recipientLabel: 'Sepolia endpoint', planHash: destSpecHash(dest) };
const sig = await signAmane(agent, 'ActionIntent', bridge);

await suiEndpoint.bridgeOutWormhole(route, bridge, sig);           // source leg
const vaa = /* signed VAA for the Token Bridge message */;
await evmEndpoint.receiveCrossChain(bridge, sig, dest, evmWormholeAdapterId, vaa); // reserved
await evmEndpoint.executeReserved(amaneDigest('ActionIntent', bridge), nextAction, nextSig);
```

## SDK reference

### `AmaneEvmEndpoint`

| Method | Purpose |
|---|---|
| `static deploy({ publicClient, relayer, accountId, controllers, threshold, registry, ext })` | Deploy a core v3 account (non-upgradeable, no admin). |
| `state()`, `coreVersion()`, `leaseStatus(id)`, `nonceUsed(id, n)` | Reads. |
| `installPolicy(policy, sigs)`, `activateLease(lease, sig)` | Root and lease configuration. |
| `executeAction(intent, sig, opts?)` | Execute an agent action (`SWAP`, `PAY`, `REPAY`, `BRIDGE`). |
| `receiveCrossChain(src, srcSig, dest, transportId, data, opts?)` | Redeem a transport delivery and reserve it for its intent. |
| `executeReserved(intent, action, sig, opts?)` | Spend a reservation with the action it committed to. |
| `recoverArrival(src, srcSig, dest, transportId, data, opts?)` | Redeem an undeliverable arrival into quarantine. |
| `releaseReservation(intent)` | Move an expired reservation into quarantine. |
| `locked(token)`, `reservation(intent)` | Reserved / quarantined amounts; reservation state. |
| `pause(msg, sig)`, `unpause(msg, sigs)`, `revokeLease(msg, sig)`, `withdraw(msg, sigs)` | Owner controls. |

### `AmaneSuiEndpoint`

| Method | Purpose |
|---|---|
| `static create({ client, packageId, relayer, accountId, chainRef, controllers, threshold })` | Create a shared account object. |
| `installPolicy`, `activateLease`, `pause`, `unpause`, `revokeLease`, `withdraw` | Owner controls. |
| `pay(coinType, intent, sig)` | Core-native pinned payment. |
| `swapCetus(route, intent, sig)` | Swap through a Cetus CLMM adapter. |
| `bridgeOutWormhole(route, intent, sig, { reservedFor? })` | BRIDGE out through the Wormhole adapter (optionally from a reservation). |
| `redeemWormhole(route, vaa, src, srcSig, dest, { recovery? })` | Redeem a VAA and reserve (or quarantine) the arrival. |
| `payReserved(coinType, intent, action, sig)`, `releaseReservation(intent)` | Reservation spending and expiry. |
| `vaultBalance`, `reservedOf`, `quarantinedOf`, `reservation`, `intentUsed`, `policyVersion`, `isPaused`, … | Reads. |
| `wormholeSequence(digest, emitter)` | Sequence of the Wormhole message a transaction published. |

### Options and outcomes

Every mutating call simulates first. A policy rejection is returned as `REJECTED_BY_AMANE` with its code and **costs no gas**. Pass `{ submitRejected: true }` to land the rejected transaction anyway so the rejection has an on-chain receipt. Codes are stable across chains (e.g. `1310 AMANE_ACTION_RECIPIENT_NOT_ALLOWED`, `1400 AMANE_BUDGET_PER_ACTION`, `1802 AMANE_XCHAIN_SPEC_MISMATCH`); see `packages/core/src/codes.ts`.

### Signing helpers

`signAmane(signer, primaryType, message)` and `signThreshold(signers, primaryType, message)` (sorted by signer address, as both cores require). Any viem-compatible typed-data signer works.

---

## Deployments

All testnet addresses, package ids, adapter ids, upstream protocol objects and deployment transactions are recorded in [`deployments/testnet.json`](deployments/testnet.json) — the SDK and scripts read from it rather than from constants.

| | Ethereum Sepolia | Sui Testnet |
|---|---|---|
| Core | `AmaneAccount` v3 (per account) + shared `AmaneAccountExt` | `amane` core v5 (frozen) |
| Adapter registry / dispatch | append-only `AdapterRegistry` | witness-bound tickets |
| Adapters | Transfer Pay, Uniswap v3 Swap, Aave v3 Repay, Wormhole Bridge | Transfer Pay (native), Cetus CLMM Swap (v4), Cetus Pinned Swap (v4), Wormhole Bridge (v5) |
| Upgrade authority | none | packages frozen (`UpgradeCap` made immutable) |

## Live testnet proof

The repository includes live scripts that deploy fresh endpoints and run allowed actions and attacks against the real chains:

- `packages/sdk/scripts/testnet-gauntlet.ts` — two-chain policy, lease, pay, pause, revoke, recover.
- `packages/sdk/scripts/live-v2-evm.ts` — Uniswap v3 swap and a real Aave v3 debt repaid for a pinned beneficiary.
- `packages/sdk/scripts/live-v2-sui.ts` — Cetus CLMM swap through the project pool.
- `packages/sdk/scripts/live-bridge-roundtrip.ts` — **Sui ⇄ Sepolia round trip through Amane on both chains over Wormhole**:
  1. Sui agent `BRIDGE`s 20 AMUSD to the Sepolia endpoint; the arrival is **reserved** on Sepolia for that intent.
  2. A reserved `BRIDGE` sends 12 back to Sui, where the arrival is reserved and paid to the owner's pinned wallet.
  3. A second reserved `BRIDGE` with a 3-minute destination deadline expires in flight; on Sui it can only be **quarantined**, then withdrawn by the root 2-of-2 to the pinned recovery address.
  4. The unspent Sepolia reservation expires into quarantine and is recovered by the root.

  Attacks exercised against the live contracts include: bridge to an unpinned endpoint, over-cap bridge, forged agent signature (both chains), substituted destination spec (both chains), VAA presented for a different intent (both chains), VAA replay (both chains), spending reserved funds outside the reservation, reserved funds sent to an attacker endpoint, over-reservation, different action on reserved funds, paying a reserved arrival to someone else, double spend of a reservation, late delivery to an expired destination, premature recovery, and an agent attempting to withdraw quarantined funds.

## Threat model

Amane assumes the agent may be wrong, prompt-injected, stale or fully compromised, and that relayers, RPCs and bridges are untrusted.

- **Agent key**: can only sign actions inside its lease. Cannot sign leases, change policy, withdraw, pick arbitrary targets or recipients, or spend reserved funds outside their reservation.
- **Relayer / executor**: can submit, delay or censor. Cannot alter a signed action, broaden a lease, redirect output or take custody. Pause messages can be relayed by anyone.
- **Lease issuer**: bounded by its own aggregate caps, smaller than the root policy.
- **Bridge / transport**: can delay or fail to deliver. Cannot choose the destination action, recipient, asset or amount; cannot replay; a tampered payload fails the intent-digest check. Failed or late deliveries end in quarantine, recoverable only by the root.
- **Root controllers**: a fully compromised threshold is out of scope; mitigated by threshold signing, pinned recovery destinations and admin-free code.

## Testing

```bash
npm test          # core + sdk (vitest), evm (forge), sui (sui move test; SUI=/path/to/sui to override)
npm run vectors   # regenerate golden vectors and Move fixtures; the diff must be empty
```

| Suite | Tests |
|---|---|
| Foundry (unit, cross-chain, Wormhole, adversarial, invariants) | 178 |
| Move (account, adversarial, cross-chain, golden parity) | 126 |
| `@amane/core` (hashing, codes, subset rules, cross-chain) | 55 |
| `@amane/sdk` (outcome classification) | 10 |

## Deploying your own

```bash
# EVM registry and infrastructure
DEPLOYER_PRIVATE_KEY=... forge script evm/script/DeployInfra.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast

# Sui core (published, then frozen)
SUI=/path/to/sui scripts/deploy-sui.sh
```

Adapters are deployed and registered (EVM) or published and frozen (Sui) separately; record everything in `deployments/testnet.json`. The Wormhole adapters are deployed as a pair: the Sui bridge object pins the EVM adapter address once (via a one-time `SetupCap`), and the EVM adapter pins the Sui adapter's `EmitterCap` id.

## Known limitations

- **Not audited.** Immutable code means bugs are permanent; fixes ship as new versions and accounts move explicitly.
- **Cross-chain revocation is not atomic.** Until a revoke lands on every endpoint, an agent key can spend the remaining per-endpoint budget. Keep leases short and budgets small.
- **Sui `chainRef` is asserted by the creator** (Move cannot read the chain id); clients verify the live chain identifier before signing. Every struct also binds the account object id.
- **Sui adapter ids derive from the witness type name**, which an upgrade would not change; adapter packages must be published immutable (checked off-chain).
- **Sui adapters are bound to a core version's `Account` type**: v4 swap adapters do not operate v5 accounts; a v5 build of an adapter is a new adapter id.
- **Sui core v5 executes reserved `PAY` and `BRIDGE`**; a reservation committed to a Sui `SWAP` can only expire into quarantine.
- **Upstream protocols are mutable.** Adapters pin their bindings and fail closed on drift, leaving funds in the account.
- **Wormhole testnet** runs a single guardian; Sepolia-originated transfers are signed only after Ethereum finality (~15 minutes).
- **Price floors** exist only in `TESTNET_FIXED` mode (owner-set per pair). Oracle modes are future work.
- **A single RPC can lie about receipts**; the SDK can land rejections on-chain, but a client trusting one RPC cannot detect false receipts.

## Repository layout

```
packages/core     canonical schema, EIP-712 hashing, ids, subset checks, DestSpec, rejection codes
packages/sdk      EVM and Sui relayers, signing helpers, artifacts, live testnet scripts
evm/              Solidity cores, registry, adapters, Foundry tests
sui/amane         Move core
sui/amane_*       Sui adapters (Cetus, Cetus pinned, Wormhole) and demo tokens
vectors/          golden vectors shared by TypeScript, Solidity and Move
deployments/      testnet deployment manifest
scripts/          deployment helpers
```

## License

MIT — see [LICENSE](LICENSE).
