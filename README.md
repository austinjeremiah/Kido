# Kido

**A foundry for bounded financial agents.**

You describe, in your own words, what you want an agent to do with your money. Kido interviews you
until the requirements are unambiguous, compiles a canonical blueprint, selects providers by what
they have actually proven rather than by what they claim, gives the agent a verifiable public
identity, and builds a runtime whose every financial action is bounded **on-chain** — on Ethereum
and on Sui — by [Amane](https://github.com/Kaushikh76/Amane).

No model sits in the authorization path. The chain decides.

> **Status:** testnet prototype — Ethereum Sepolia and Sui Testnet. **Not audited.** Testnet assets
> only.

---

## Table of contents

- [The problem](#the-problem)
- [What Kido actually is](#what-kido-actually-is)
- [The one-paragraph version](#the-one-paragraph-version)
- [Repository layout](#repository-layout)
- [System architecture](#system-architecture)
- [The pipeline, stage by stage](#the-pipeline-stage-by-stage)
  - [1. Design interview](#1-design-interview)
  - [2. Blueprint](#2-blueprint)
  - [3. Provider registry and selection](#3-provider-registry-and-selection)
  - [4. Security review](#4-security-review)
  - [5. Simulation](#5-simulation)
  - [6. Build](#6-build)
  - [7. Authority compilation](#7-authority-compilation)
  - [8. Runtime](#8-runtime)
- [Sponsor integration — ENS](#sponsor-integration--ens)
  - [Why a name at all](#why-a-name-at-all)
  - [What Kido publishes](#what-kido-publishes)
  - [ENSv2: the version that matters](#ensv2-the-version-that-matters)
  - [Auto-provisioning, in full](#auto-provisioning-in-full)
  - [Per-agent resolvers and scoped record managers](#per-agent-resolvers-and-scoped-record-managers)
  - [Verification: what a name proves](#verification-what-a-name-proves)
  - [Revocation](#revocation)
  - [The rule we will not break](#the-rule-we-will-not-break)
  - [ENS as an execution-time gate](#ens-as-an-execution-time-gate)
  - [ENS deployment discovery](#ens-deployment-discovery)
  - [ENS file map](#ens-file-map)
- [Sponsor integration — Sui](#sponsor-integration--sui)
  - [Why Sui, specifically](#why-sui-specifically)
  - [The Move core](#the-move-core)
  - [Ethereum keys on Sui](#ethereum-keys-on-sui)
  - [Hot-potato adapters](#hot-potato-adapters)
  - [Cetus CLMM](#cetus-clmm)
  - [SuiNS](#suins)
  - [Seal](#seal)
  - [Nautilus](#nautilus)
  - [Wormhole: Sui ⇄ Ethereum](#wormhole-sui--ethereum)
  - [Sui file map](#sui-file-map)
- [Amane: the authority layer](#amane-the-authority-layer)
- [Privacy](#privacy)
- [Identity, authority and discovery are three different things](#identity-authority-and-discovery-are-three-different-things)
- [The frontend](#the-frontend)
- [Live testnet scenarios](#live-testnet-scenarios)
- [Running it](#running-it)
- [HTTP API](#http-api)
- [CLI](#cli)
- [Honesty machinery](#honesty-machinery)
- [Threat model](#threat-model)
- [Known limitations](#known-limitations)
- [Deployed addresses](#deployed-addresses)
- [Glossary](#glossary)
- [License](#license)

---

## The problem

An AI agent that can move money is a key with a language model attached to it.

Every practical deployment of an autonomous financial agent today reduces to the same shape: the
agent holds a private key, and the safety of your funds is the safety of the agent's reasoning. That
is an unbounded trust assumption dressed up as a product. It fails in four ordinary ways:

1. **Prompt injection.** Market data, an RSS feed, a webpage, a message from another agent — any of
   these can carry instructions. If the agent's authority is "whatever it decides to sign", then
   whoever controls its inputs controls your treasury.
2. **Model drift and plain error.** A model does not need to be attacked to be wrong. It needs to be
   slightly miscalibrated once, at the wrong moment, holding a key.
3. **Compromise of the host.** The key sits in a process, on a machine, on someone's cloud. The
   blast radius of that machine is the balance of that wallet.
4. **No way to stop it.** When the thing goes wrong, "stopping it" means racing it to move funds out
   of a wallet whose key it still holds.

The usual mitigations are all off-chain: better prompts, guardrail models, an approval queue, a
spending limit enforced by the same software that might be compromised. None of them is a
*guarantee*. They are all code that an attacker who owns the process can skip.

**Kido's position is that the limit has to live somewhere the agent cannot reach.** Not in the
prompt. Not in the orchestrator. Not in a wrapper library. On-chain, in a contract that verifies a
signature and checks a budget before value moves — where an agent that has been fully compromised
still cannot exceed what its owner signed.

That contract layer is Amane. Kido is the thing that designs, proves, names and operates agents on
top of it.

---

## What Kido actually is

Kido is a **backend**, exposed through an HTTP API and a CLI, plus a **web workbench** that drives
it. It is not a wallet, not a chatbot and not an agent framework. It is a compiler and a foundry:
natural language in, a bounded and named on-chain agent out.

It does seven things:

| | What | Why it matters |
|---|---|---|
| **1** | **Interviews you** until the requirements are unambiguous | An agent built on an ambiguous requirement is an agent with an invented limit |
| **2** | **Compiles a canonical blueprint** — versioned, hashed, chained | One artifact that everything downstream reads; no drift between what you agreed and what runs |
| **3** | **Selects providers by proof**, from a registry that records implementation status | A `SIMULATED` provider is never presented as live |
| **4** | **Gives the agent a public identity** through ENS and SuiNS | Anyone can look up what this agent is, from the chain, without asking Kido |
| **5** | **Compiles authority into Amane** — an owner-signed root policy and a short-lived agent lease | The limit is enforced by the chain, not by Kido |
| **6** | **Runs deterministic monitors** that wake agents, which propose typed actions | The decision to act is deterministic; the model only proposes |
| **7** | **Answers questions about itself** from a self-model, and says "unknown" rather than guessing | An agent that cannot state its own authority is not auditable |

Two things Kido deliberately **does not** do:

- **It never holds a root controller key.** The API takes controller, issuer and agent *addresses*.
  You sign the root policy. Kido cannot widen its own authority.
- **It never lets a model decide authority.** A model reading of your words can never override your
  words. Confirmed requirements are immutable until you explicitly edit them, which opens a new
  blueprint revision.

---

## The one-paragraph version

> You say *"protect my Aave position using liquidity on Sui."* Kido asks the questions that make
> that statement enforceable — which position, what health factor, how much may it spend without
> asking you, may it ever withdraw, who may it pay, what must stay private. It compiles a blueprint,
> registers `guardian.yourorg.eth` on ENSv2 with a resolver of its own and an `agent-context` record
> that anyone can read, compiles your answers into an Amane root policy you sign once and a
> one-hour agent lease, and starts a runtime. A deterministic monitor reads your Aave health factor.
> When it crosses your threshold, the agent proposes a repay. The proposal is compiled into an EIP-712
> `ActionIntent`, signed by a key that can only sign actions inside the lease, relayed by anyone, and
> checked on-chain — signature, lease, adapter, pinned beneficiary, budget — before a single token
> moves. If the liquidity is on Sui, the same signed authority bridges it through Wormhole and the
> Sepolia account reserves the arrival for that one intent and no other.

---

## Repository layout

```
kido/
├── README.md              ← you are here
├── frontend/              the web workbench (Next.js 15, React 19)
└── Backend/
    ├── Kido/              the foundry: interview → blueprint → build → runtime
    └── Aname/             Amane: the on-chain authority layer (Solidity + Move + SDK)
```

`Backend/Aname` is the [Amane](https://github.com/Kaushikh76/Amane) repository, vendored as the
authority substrate. `Backend/Kido` depends on it through `@amane/core` and `@amane/sdk`, and
`packages/amane-bridge` is the **only** package in Kido allowed to import them — so the surface
between the foundry and the chain is one file wide and auditable.

### `Backend/Kido`

```
apps/kido                  HTTP API and CLI
packages/design-interview  interview engine, negation-aware parsing, private-input redaction
packages/blueprint         canonical schema, validation, revisions, hashing
packages/registry          provider and capability registry, chain profiles
packages/knowledge         provider knowledge packs and drift checks
packages/foundry           lifecycle: review, simulate, build, deploy authority, Wormhole transport
packages/kido-runtime      monitors, responders, executor, recovery, cross-chain engine, self-model
packages/kido-agents       model-facing specialist agents (no key access)
packages/identity          KidoAgentId, ENS and SuiNS bindings, verification
packages/privacy           privacy compiler, Seal / Nautilus / CRE adapters, leak guard
packages/amane-bridge      the only package that talks to Amane
packages/kido-eval         live conversational evaluation
contracts/                 KidoCreReceiver (Foundry)
move/                      kido_seal reader policy, kido_nautilus decision verifier
workflows/kido-cre         CRE decision workflow
knowledge/                 generated knowledge packs (facts + manifest per provider)
scripts/                   live testnet scenarios and audits
```

### `Backend/Aname`

```
packages/core     canonical schema, EIP-712 hashing, ids, subset checks, DestSpec, rejection codes
packages/sdk      EVM and Sui relayers, signing helpers, artifacts, live testnet scripts
evm/              Solidity cores, AdapterRegistry, adapters, Foundry tests
sui/amane         Move core (account, EIP-712, secp256k1 recovery)
sui/amane_*       Sui adapters (Cetus, Cetus pinned, Wormhole) and demo tokens
vectors/          golden vectors shared by TypeScript, Solidity and Move
deployments/      testnet deployment manifest
```

---

## System architecture

```
                         ┌───────────────────────────────────────────────┐
                         │  frontend/  — the workbench                    │
                         │  landing → /new (7-step creation) → projects/  │
                         └────────────────────┬──────────────────────────┘
                                              │ same-origin /api/* (no CORS)
                         ┌────────────────────▼──────────────────────────┐
                         │  Backend/Kido — apps/kido (HTTP API + CLI)     │
                         └──┬──────────┬──────────┬──────────┬───────────┘
                            │          │          │          │
        ┌───────────────────▼──┐  ┌────▼─────┐ ┌──▼───────┐ ┌▼──────────────┐
        │ design-interview      │  │ blueprint│ │ registry │ │ knowledge     │
        │ asks, parses negation │  │ canonical│ │ what is  │ │ per-provider  │
        │ redacts private input │  │ + hashed │ │  PROVEN  │ │ facts + drift │
        └───────────────────┬──┘  └────┬─────┘ └──┬───────┘ └───────────────┘
                            └──────────┼──────────┘
                                       ▼
                    ┌──────────────────────────────────────┐
                    │ foundry — review · simulate · build   │
                    └───────┬────────────────┬─────────────┘
                            │                │
             ┌──────────────▼───┐   ┌────────▼──────────────┐
             │ identity          │   │ privacy               │
             │ ENS · SuiNS       │   │ Seal · Nautilus · CRE │
             │ KidoAgentId       │   │ leak guard            │
             └──────────────┬───┘   └────────┬──────────────┘
                            └────────┬───────┘
                                     ▼
                    ┌──────────────────────────────────────┐
                    │ kido-runtime                          │
                    │ monitors → agents propose → executor  │
                    │ recovery · cross-chain state machine  │
                    └──────────────────┬───────────────────┘
                                       │ typed action
                    ┌──────────────────▼───────────────────┐
                    │ amane-bridge  (the only door)         │
                    └──────┬────────────────────┬──────────┘
                           │                    │
              ┌────────────▼────────┐  ┌────────▼─────────────────┐
              │ Ethereum Sepolia     │  │ Sui Testnet               │
              │ AmaneAccount v3      │  │ amane::account v5         │
              │ AdapterRegistry      │  │ witness-bound tickets     │
              │ Uniswap · Aave       │  │ Cetus CLMM                │
              │ Wormhole adapter  ◄──┼──┼─► Wormhole adapter        │
              │ ENSv2 identity       │  │ SuiNS · Seal · Nautilus   │
              └──────────────────────┘  └───────────────────────────┘
```

The important property of this diagram: **nothing above `amane-bridge` can move value.** The
runtime proposes; the bridge compiles the proposal into a signed intent; the chain accepts or
rejects it. A total compromise of everything above the bridge yields an attacker who can sign
actions inside a lease — and nothing more.

---

## The pipeline, stage by stage

### 1. Design interview

`packages/design-interview`

The interview exists because the gap between *"pay my supplier"* and an enforceable policy is
enormous, and every unasked question becomes an invented limit.

It asks in human terms: *Can it withdraw? Can it send to any address, or only ones you approve? How
much can it spend without asking you? What must stay hidden, and from whom?* It never asks you to
express a budget in base units or to name a contract.

Three properties make it different from a form with a chat skin:

**Negation-aware parsing.** *"It should never be able to withdraw"* and *"it should be able to
withdraw"* differ by one word and by everything else. The parser handles negation, hedges and
scope explicitly rather than letting a model's summary stand in for your sentence.

**Your words are authoritative.** Every resolved requirement carries a `Provenance`:

```ts
{ kind: "USER_ANSWER", quote: "only recipients I approve", turn: 7 }
{ kind: "SAFE_DEFAULT", reason: "no withdrawal requested; withdrawal is denied by default" }
{ kind: "INFERRED", from: ["chains"], rule: "bridge is required when assets span two chains" }
```

A requirement resolved from `USER_ANSWER` and marked `confirmed` cannot be changed by any later
model reading. Changing it requires an explicit edit, which opens a new blueprint revision with a
recorded parent hash.

**Private values never enter the transcript.** If you say your liquidation threshold is 1.35 and
mark it private, the number is stored as a `PrivateValueSpec` reference — `thresholdPrivateRef` —
and the literal never reaches the blueprint, the model context, the logs or the repository. This is
enforced mechanically by `npm run canary-scan`, which plants a canary value and fails the build if
it appears anywhere it should not.

Requirements are classified so the interview knows what it may decide for you:

| Class | Meaning |
|---|---|
| `USER_REQUIRED` | Only you can answer. Kido will not proceed without it. |
| `SAFE_DEFAULT` | Kido may default, and records that it did and why. |
| `INFERABLE` | Derivable from other confirmed answers, with the rule recorded. |

Topics: `AUTHORITY`, `CHAIN`, `ACTIONS`, `LIMITS`, `IDENTITY`, `PRIVACY`, `DATA`, `RECOVERY`,
`OPERATIONS`, `OBJECTIVE`.

### 2. Blueprint

`packages/blueprint` · schema version `kido.agent-blueprint/v2`

The blueprint is the single source of truth. Everything downstream — the security review, the
simulator, the identity compiler, the privacy compiler, the authority compiler, the runtime — reads
it and only it.

```ts
BlueprintSchema = {
  schemaVersion, projectId, kidoAgentId, revision, parentRevisionHash,
  objective: { statement, summary },
  requirements: RequirementResolution[],   // with provenance and confirmation
  chains:      ("ethereum-sepolia" | "sui-testnet")[],
  identity:    IdentitySpec,               // public?, organization, bindings, endpoints
  protocols:   ProtocolSelection[],
  assets:      AssetSpec[],
  dataSources: DataSourceSpec[],           // minTrust, maxAgeMs, onUnavailable
  privacy:     PrivacySpec,
  authority:   AuthoritySpec,              // mode, limits, payees, beneficiaries, swap floors
  monitors:    MonitorSpec[],
  triggers, actions, reasoning, agents, recovery,
  crossChain?: CrossChainPolicy,
  amane?:      AmaneBindingSpec,           // manifest ref, accountId, endpoints, policyHash
  simulationScenarios, securityAssertions, generatedModules,
  deployment:  { environment: "testnet", chains },
}
```

Three structural decisions worth calling out:

**`kidoAgentId` is the root identity.** Format `kido:agent:[a-z2-7]{16}` — Crockford base32. It is
*not* an ENS name, not a SuiNS name, not an address. Names are bound *to* it; it is not derived
*from* them. That is what makes one agent legible on two chains without either chain's name service
being load-bearing.

**Limits are strings of base units.** `baseUnits = /^(0|[1-9][0-9]{0,30})$/`. Not floats, not
numbers. A float in a financial limit is a rounding bug waiting for a demo.

**Revisions are chained.** `parentRevisionHash` links each revision to the one it amends, and
`blueprintHash` is a deterministic hash of the canonical form. The hash is what gets published in
the ENS `agent-context` record, which is what makes a stale advertisement detectable — see
[Verification](#verification-what-a-name-proves).

Authority modes, in increasing order of what the agent may do:

| Mode | Meaning |
|---|---|
| `NONE` | No authority at all |
| `READ_ONLY` | Observes; cannot propose |
| `PROPOSE_ONLY` | Proposes; a human executes |
| `APPROVAL_REQUIRED` | Every action needs an owner signature |
| `BOUNDED_AUTONOMOUS_FINANCE` | Acts alone, inside signed on-chain limits |

### 3. Provider registry and selection

`packages/registry`, `packages/knowledge`

This is the part of Kido that exists because of how easy it is to lie in a hackathon.

Every integration — ENS, SuiNS, Seal, Nautilus, Chainlink CRE, Aave v3, Uniswap v3, Cetus CLMM,
Amane, Wormhole, LayerZero — is a registry record carrying an `ImplementationStatus` that says what
has actually been *proven*:

| Status | Meaning |
|---|---|
| `NOT_IMPLEMENTED` | Not built. Nothing about it may be claimed. |
| `IMPLEMENTED_LOCAL` | Built and tested locally. Not live on a testnet, not attested. |
| `SIMULATED` | Exercised only through a simulator or mock. Never presented as live. |
| `TESTNET_LIVE` | Proven by live runs on a public testnet, with evidence. |
| `LIVE_ATTESTED` | Live with hardware or protocol attestation verified. |
| `BLOCKED_ENV` | Cannot run until a missing environment prerequisite exists. |
| `BLOCKED_AUTH` | Cannot run until an operator completes an interactive login. |
| `BLOCKED_UPSTREAM` | Cannot run until an upstream dependency changes. |

Each record also carries `proven[]`, `notProven[]`, `doesNotProvide[]` and `evidence[]`, and a
per-capability status where capabilities differ — ENS `RESOLVE` can be `TESTNET_LIVE` while
`REGISTER` is blocked, and the registry says so rather than averaging them.

**Selection only counts proven capabilities.** `reg.select({ kind, chain, capabilities,
acceptStatus })` will not return a provider for a capability it has not proven at the requested
level. This is why `SIMULATED` is never silently promoted to live anywhere in the product.

Current status:

| Provider | Role | Implementation |
|---|---|---|
| **Amane** | financial authority (Ethereum + Sui) | `TESTNET_LIVE` |
| **Aave v3** | lending position state, repay (Ethereum) | `TESTNET_LIVE` |
| **Uniswap v3** | swap (Ethereum) | `TESTNET_LIVE` |
| **Cetus CLMM** | swap (Sui) | `TESTNET_LIVE` |
| **Wormhole** | cross-chain transport (Token Bridge) | `TESTNET_LIVE` |
| **ENS** | identity binding (Ethereum) | `TESTNET_LIVE` |
| **Seal** | encrypted state with on-chain reader policy (Sui) | `TESTNET_LIVE` |
| **SuiNS** | identity binding (Sui) | reads live; registration `BLOCKED_ENV` |
| **Nautilus** | private decisions in a TEE (Sui) | `IMPLEMENTED_LOCAL` |
| **Chainlink CRE** | private decisions | `SIMULATED` (`BLOCKED_AUTH`) |
| **LayerZero** | transport | `BLOCKED_UPSTREAM` |

Alongside the registry sit **knowledge packs** — `knowledge/<kind>/<provider>/{manifest.json,
facts.md}` — carrying researched, dated facts: deployment addresses, SDK versions, a `trust`
profile (`protects`, `verifies`, `requiresTrustIn`, `doesNotProtectAgainst`), failure modes and
limitations. `GET /knowledge/drift` re-checks them against the chain so a pack that has gone stale
is caught rather than believed.

### 4. Security review

`packages/foundry/src/review.ts`

The review runs before anything is built, against the blueprint alone. It catches the class of error
that is invisible in prose and obvious in structure:

- An aggregate limit at or above the sum of per-agent limits — it can never bind, and you will
  believe it protects you.
- A privacy requirement whose `plaintextBoundary` contradicts its `hiddenFrom` set — "keep it in
  Kido's secret store" *and* "hide it from Kido's backend" cannot both be true.
- A cross-chain policy naming a transport the registry does not have, or one that does not span the
  declared chains.
- A `BOUNDED_AUTONOMOUS_FINANCE` agent with no pinned payees.
- A withdrawal permitted without a pinned recovery destination.
- A monitor whose data source has `minTrust: VERIFIED_ORACLE` bound to an `RPC_DIRECT` provider.

Each finding names what is wrong, why it matters and what to change.

### 5. Simulation

`packages/foundry/src/simulate.ts`

Simulation runs the blueprint's declared scenarios against a deterministic model of the policy,
including the attack families — over-cap, unpinned recipient, forged signature, replayed nonce,
substituted destination spec. A scenario's expected verdict is fixed when the scenario is written
and is never edited afterwards to make a failing run pass.

### 6. Build

`packages/foundry/src/service.ts`, `runtime-builder.ts`

The build generates the runtime modules the blueprint declares: monitors, responders, the executor
binding and the self-model. Generated code is read-only after a successful build; changing behaviour
means changing the blueprint and rebuilding, which produces a new revision hash — which in turn
makes every ENS record advertising the old hash detectably stale.

### 7. Authority compilation

`packages/kido-runtime/src/policy-compiler.ts`

This is the hinge of the whole system: the step where a set of English answers becomes an
EIP-712 structure you sign.

```ts
compilePaymentMandate(mandate, endpoints, controllers, now) → {
  policy:  RootPolicy,          // you sign this, once, with a threshold
  lease:   (leaseId, now, lifetime) => AgentLease,
  bindings: Record<Chain, EndpointBinding>,
  crossChainTotal: bigint,      // worst-case exposure = SUM of per-endpoint limits
  forbidden: string[],
}
```

Two safeguards:

**The compiled result is checked with the same rules the chains enforce.** `assertPolicyWellFormed`
and `assertLeaseIsSubset` come from `@amane/core` — the same functions the Solidity and Move cores
implement. So what the workbench displays and what the chain will accept cannot drift apart. This is
tracked as `KIDO-INT-001`.

**`crossChainTotal` is the sum, not the max.** A single logical account with endpoints on two chains
enforces its limits *per endpoint*. If you set $500/day on each of two chains, your worst-case
exposure is $1,000/day, and Kido says so rather than showing you $500.

### 8. Runtime

`packages/kido-runtime`

```
monitors (deterministic)  →  agents (model)  →  executor  →  amane-bridge  →  chain
    aave.ts                   propose a          compile to     sign           verify
    allocation.ts             typed action       ActionIntent                  + enforce
```

**Monitors are deterministic.** `monitors/aave.ts` reads an Aave health factor. `monitors/allocation.ts`
computes drift from a target share. Neither calls a model. The decision *that* something needs
attention is arithmetic.

**Agents propose, they do not execute.** A responder (`responders/repay.ts`,
`responders/rebalance.ts`) produces a typed action. It cannot produce a target address, a raw
calldata blob, or an amount outside the lease — there is no field in the type for those things.

**The executor compiles proposals into Amane intents.** It fills in the account id, chain ref,
endpoint, policy version, lease id, nonce, adapter id/name/version, asset ids, amount, minimum out,
pinned recipient and label, deadline, plan hash and plan step — then signs with the agent key.

**Recovery is an explicit state machine.** `recovery.ts` handles partial execution; `crosschain.ts`
is a 13-state machine (`CREATED → SOURCE_AUTHORIZED → SOURCE_COMMITTED → IN_FLIGHT → ARRIVED →
RESERVED → DESTINATION_AUTHORIZED → SETTLED → COMPLETE`, with `TIMED_OUT`, `DESTINATION_FAILED`,
`RECOVERY_REQUIRED`, `RECOVERED` as the failure arms). Transitions are validated; there is no
"probably fine" path.

**The self-model answers questions about the agent.** `self-model.ts` lets the agent answer *"what
are you allowed to do?"* from its own compiled authority — and return **unknown** rather than
guess. An agent that cannot state its own limits is not auditable.

---

## Sponsor integration — ENS

This is the section to read if you are judging the ENS track.

### Why a name at all

An agent that can move money is a counterparty. Counterparties need to be identifiable, and the
identification has to survive the agent's operator going quiet.

Three concrete needs:

1. **Discovery.** Another agent, or a human, encounters `guardian.acme.eth` and needs to know what it
   is, what it claims to do, where to reach it, and which on-chain account it acts through — without
   an API key, without trusting Kido, and without Kido being online.
2. **Separation of principals.** A multi-agent organisation where every agent shares one identity is
   one agent wearing hats. Separate names mean separate principals, separate policies and separate
   blast radius.
3. **Revocation that does not require finding the operator.** Clearing a name's records is a public,
   on-chain act that anyone can observe.

ENS is the only name system for Ethereum with all of: a live registry, a resolver model rich enough
to carry structured records, delegable per-name permissions, and a published deployment anyone can
independently verify. That is why it is the identity provider for the Ethereum side.

### What Kido publishes

Every Kido agent gets a `KidoPublicAgentManifest`, published as the ENS text record `agent-context`
on the agent's own name:

```jsonc
{
  "kidoAgentId": "kido:agent:k4m2q7xr9tzb3vnh",
  "agentVersion": "3",
  "description": "Repays Aave debt when the health factor falls below the owner's threshold.",
  "supportedChains": ["ethereum-sepolia", "sui-testnet"],
  "publicCapabilities": ["LENDING_REPAY", "DEX_SWAP"],
  "webEndpoint": "https://…",
  "mcpEndpoint": "https://…",
  "blueprintCommitment": "0x9f3c…",          // hash of the exact blueprint revision
  "amaneAccountId": "0x…",                    // the account whose policy binds it
  "bindings": [                               // every name bound to this agent, on any chain
    { "provider": "ens",   "chain": "ethereum-sepolia", "name": "guardian.acme.eth" },
    { "provider": "suins", "chain": "sui-testnet",      "name": "guardian.acme.sui" }
  ],
  "accounts": { "ethereum-sepolia": "0x…", "sui-testnet": "0x…" },
  "authorityNote": "Advertised capabilities are not financial authority; authority is enforced on-chain by the account's own policy."
}
```

Plus three flatter keys for consumers that do not want to parse JSON:

| Key | Value |
|---|---|
| `agent-context` | the manifest above, as JSON |
| `kido-agent-id` | `kido:agent:…` — the root identity |
| `agent-endpoint[web]` | web endpoint |
| `agent-endpoint[mcp]` | MCP endpoint |
| `agent-endpoint[a2a]` | agent-to-agent endpoint |

`authorityNote` is a **schema literal**, not a free string — `z.literal(...)`. A manifest that omits
it, or changes it, fails validation. The sentence is load-bearing: it is the thing that stops a
reader concluding that an advertised capability is a permission.

Nothing in the manifest is a secret. This is enforced, not hoped for:

```ts
assertPublicSafe(records, blueprint)
```

throws `UnsafePublicRecordError` if the record text contains secret-shaped content
(`sk-…`, `-----BEGIN`, `suiprivkey1`, `private_key`, `mnemonic`, `api_key:`), any monitor threshold
that the blueprint marks private, any spending-limit value, or any private value id. The publish
path calls it before it writes.

### ENSv2: the version that matters

Kido integrates **ENSv2** (`contracts-v2@71a3b733`) on Sepolia — the new registry, not the legacy
one. The pieces it uses:

| Contract | Used for |
|---|---|
| `ETHRegistrar` | commit–reveal registration of `<label>.eth`, priced in MockUSDC |
| `ETHRegistry` | `getExpiry`, `getSubregistry`, `setSubregistry`, `ownerOf`, `getTokenId` |
| `UniversalResolverV2` | `resolve(dnsEncode(name), calldata)` and `findResolver` |
| `VerifiableFactory` | deterministic proxy deployment for per-agent resolvers and registries |
| `PermissionedResolverImpl` | the resolver each agent name gets its own instance of |
| `UserRegistryImpl` | the subname registry a parent name gets, for issuing agent subnames |
| `MockUSDC` | the ENSv2 Sepolia beta payment token |

Kido also records the legacy addresses (`legacyRegistry`, `legacyPublicResolver`,
`legacyNameWrapper`) in the knowledge pack so the distinction is explicit rather than assumed.

ENSv2's **EAC role bitmap** is used directly. Roles sit in the low 128 bits and their admin roles
128 bits higher:

```ts
const R = (n: number) => 1n << BigInt(n);
const withAdmin = (r: bigint) => r | (r << 128n);

const RESOLVER_OWNER_ROLES      = withAdmin(R(0) | R(4) | R(8) | R(20) | R(24) | R(28));
const USER_REGISTRY_OWNER_ROLES = withAdmin(R(0) | R(8) | R(12) | R(16) | R(20) | R(24));
const SUBNAME_OWNER_ROLES       = R(20) | R(24);   // no admin bits — cannot escalate
```

A subname owner gets `R(20) | R(24)` **without** the admin halves. It can operate its own name; it
cannot grant itself more.

### Auto-provisioning, in full

This is the part judges should look at closely: **Kido registers ENS names as part of building an
agent.** It is not a manual step you do beforehand and paste in.

`compileIdentityPlan(blueprint, registry, manifest)` produces, per chain, a `PlannedBinding`:

```ts
{
  providerId: "ens",
  chain: "ethereum-sepolia",
  name:   "guardian.acme.eth",
  parent: "acme.eth",
  label:  "guardian",
  records: { "agent-context": "…", "kido-agent-id": "…", "agent-endpoint[web]": "…" },
  liveCapable: true,
  blockers: [],
}
```

The name is `<role>.<org>.<tld>` — role from the agent's role in the blueprint with a trailing
`Agent` stripped, org from `identity.organization` or the project id, both slugged to
`[a-z0-9-]`. An org shorter than five characters is suffixed `-kido` so it does not collide with
short registered names.

`liveCapable` and `blockers` come from **per-capability** status. The plan does not claim it can
register a name if the registry says `REGISTER` is blocked; it reports the blocker with the
provider's own note.

#### Registering a parent `.eth` name

`EnsIdentityAdapter.register(label, owner)`:

1. **Availability.** `ETHRegistrar.isAvailable(label)`. If taken, return `FAILED` with
   `"name not available"` — not an exception, a receipt.
2. **Deploy the resolver first.** `deployResolver(name)` via `VerifiableFactory.deployProxy` of
   `PermissionedResolverImpl`, with a salt committing to `("OwnedResolver", deployer, namehash(name))`.
   This happens before registration so the name is registered *pointing at its own resolver*, never
   at a shared one.
3. **Price and pay.** `getRegisterPrice(label, duration, mockUsdc)` → `base + premium`. Mint
   MockUSDC (the ENSv2 Sepolia beta token has an open mint) and `approve` the registrar.
4. **Commit.** `makeCommitment(label, owner, secret, subregistry=0x0, resolver, duration, referrer)`
   with `secret = keccak256(name|timestamp|random)`, then `commit(commitment)`.
5. **Wait `MIN_COMMITMENT_AGE`.** Not by sleeping on wall-clock time — `waitForChainTime` polls
   `getBlock().timestamp` until the chain has actually advanced past the minimum, plus three
   seconds. A commit–reveal that races the chain clock is a flaky demo.
6. **Register.** `register(label, owner, secret, 0x0, resolver, duration, mockUsdc, referrer)`.
7. Return an `IdentityReceipt` with every transaction hash and `detail: "resolver 0x…"`.

Default duration is `2_419_200` seconds — 28 days, the registrar's minimum.

#### Issuing an agent subname

`createSubIdentity(parent, label, records)`:

1. **Find or create the parent's subname registry.** `ETHRegistry.getSubregistry(parentLabel)`. If
   zero, deploy a `UserRegistryImpl` proxy through `VerifiableFactory` with a salt committing to
   `("UserRegistry", namehash(parent), 1)`, then `ETHRegistry.setSubregistry(labelhash(parentLabel),
   userRegistry)` and `userRegistry.setParent(ethRegistry, parentLabel)`.
2. **Deploy a resolver for the subname, writing the records in the same transaction.**
   `deployResolver(name, records)` passes the `setText` calls as the proxy's `initialize` payload —
   so the agent's name never exists in a state where it resolves but carries no manifest.
3. **Inherit the parent's expiry.** `ETHRegistry.getExpiry(labelhash(parentLabel))` — a subname
   cannot outlive its parent.
4. **Register** into the user registry with `SUBNAME_OWNER_ROLES` (no admin bits).

Everything is a receipt, never a thrown exception:

```ts
{ providerId, chain, operation: "REGISTER" | "SUBNAME" | "PUBLISH_RECORDS" | "REVOKE",
  name, txs: Hex[], status: "CONFIRMED" | "FAILED" | "BLOCKED_ENV", detail? }
```

A `BLOCKED_ENV` receipt is a first-class outcome. The build continues, the blueprint records the
binding as `PLANNED` rather than `ACTIVE`, and the workbench shows it as planned. It never claims a
name it does not hold.

### Per-agent resolvers and scoped record managers

Every Kido agent name gets **its own `PermissionedResolver` instance**.

The obvious alternative is one resolver for the whole organisation with per-name permissions. Kido
does not do that, for one reason: a scoped record manager for agent A must not be able to write
agent B's records. Sharing a resolver makes that a permissions question. Separate instances make it
a structural impossibility — the write goes to a different contract.

This is what `SCOPED_RECORD_MANAGER` in the capability vocabulary means. It is the capability that
lets an organisation delegate *"this process may update this one agent's records"* without also
handing over the ability to rewrite every sibling.

`inspect(name)` also handles a subtlety that matters for correctness. ENS resolves subnames through
their parent by wildcard fallback, so a resolver found for `notregistered.acme.eth` may belong to
`acme.eth`. Kido uses `UniversalResolverV2.findResolver`, which returns the resolver **and the
offset at which it was found**, and only treats a subname as registered when the offset is `0` —
that is, when the name has a resolver of its own.

### Verification: what a name proves

`verifyBinding(provider, name, expect)` checks a name against what the agent actually is, and
returns one of nine verdicts:

| Verdict | Meaning |
|---|---|
| `VERIFIED` | Same `KidoAgentId`, current blueprint commitment, expected account |
| `NOT_FOUND` | The name does not resolve |
| `PLANNED_NOT_REGISTERED` | The binding is planned; the name is not registered yet |
| `REVOKED` | Resolves, but carries no `KidoAgentId` — records were cleared |
| `WRONG_AGENT` | Bound to a different `KidoAgentId` |
| `STALE` | Advertises an older `blueprintCommitment` than the agent's current one |
| `WRONG_ADDRESS` | The advertised account differs from the agent's account |
| `INVALID_NAME` | Not a syntactically valid name for the provider |
| `UNVERIFIABLE` | `agent-context` exists but is not a valid Kido manifest |

The order of operations matters and is deliberate: **registration is checked before resolution**,
because some name services resolve an unregistered subname through its parent, and a naive
resolve-first check would report a name as live when nobody owns it.

`STALE` is the verdict that makes the blueprint commitment worth publishing. If an agent is
rebuilt — new limits, new payees, new revision hash — but its ENS record still advertises the old
commitment, anyone reading the name can tell that what it claims is out of date. That is a property
you cannot get from a name that only points at an address.

And the last line of the verification doc comment is the one that matters most:

> A name is discovery only; a failed check never affects financial authority, it only means the name
> must not be trusted as this agent.

### Revocation

`revoke(name, mode)` with three modes:

| Mode | Effect |
|---|---|
| `CLEAR_RECORDS` | Writes `""` to every `KIDO_RECORD_KEYS` entry. The name still resolves; it no longer claims to be any agent. |
| `UNBIND` | Same as clear, semantically distinguished for reporting. |
| `BURN_SUBNAME` | `UserRegistryImpl.unregister(labelhash(label))`. The subname ceases to exist. |

Revocation is **identity and discovery only**. It removes the agent's public claim to be that name.
It does not touch a single unit of financial authority — that lives in the Amane policy, is revoked
by `revokeLease` or `pause`, and is a different signature by a different party.

This separation is the most important idea in the whole integration, and it is worth being blunt
about why: **if clearing an ENS record could stop money moving, then whoever controls the name
controls the money.** ENS name ownership would become a financial permission, and an ENS-level
compromise would become a treasury compromise. Kido refuses that coupling.

### The rule we will not break

> **ENS answers *who*. It never answers *how much*.**

Kido's blueprint validator enforces this as a **CRITICAL** finding, `BP-016`:

```
"A financial permission is represented as an ENS registry role. Stock ENSv2 roles are not
 financial, and treating one as a spending permission means the limit is not actually enforced
 anywhere."
→ "Keep financial permissions in the ContextLock policy layer. ENS answers who, never how much."
```

A blueprint that tries to express a spending limit as an ENS role does not build. The organisation
validator carries the same doctrine in its own comment:

```ts
/* ENS here carries identity, namespace, lifecycle and revocation. It carries no financial
 * authority — that stays in the policy each agent points at. */
```

Two further organisation-level rules follow from it:

- `ORG-V-ROOT-IDENTITY` (**CRITICAL**) — an agent may not hold the organisation's root name or the
  agent namespace as its own identity. *"The root and the agent namespace are the organization, not
  a principal. Give the agent a subname."*
- `ORG-V-DUP-ENS` (**CRITICAL**) — two agents may not share a name. A shared name is a shared
  principal.
- `ORG-V-NAMESPACE-ROOT` (**HIGH**) — the agent namespace must be a subname of the org root.

### ENS as an execution-time gate

There is a second, stronger ENS integration in the lineage of this project, and it is worth
describing because it shows how far the idea can be taken.

In the ContextLock line of work, `EnsAgentIdentityVerifier.sol` is read **by the executor, at
execution time**, on every protected call:

```solidity
// 7. Live identity. A valid signature on an unexpired capability is not enough: the
//    identity must still be bound right now.
if (!identityVerifier.isIdentityCurrent(cap.agentIdentityHash, cap.agent)) {
    revert IdentityNotCurrent(cap.agentIdentityHash, cap.agent);
}
```

The agent identity hash commits to six fields:

```solidity
keccak256(abi.encode(registry, labelId, nameOwner, agent, tokenId, bindingVersion))
```

Three design choices in that contract are worth stating:

1. **`ownerOf`, never `latestOwnerOf`.** ENSv2 returns `address(0)` from `ownerOf` once a name
   expires, while `latestOwnerOf` still returns the historical owner. Using the latter would make an
   expired name look valid forever. There is a dedicated test — `test_ID_003b_latestOwnerOfWouldHaveBeenWrong`
   — whose only job is to demonstrate that trap on live state.
2. **The hash commits to the ENS *token id*.** ENSv2 regenerates the token id on `grantRoles` /
   `revokeRoles` and on re-registration. So **an ENS role change is itself an identity change**, and
   revoking any role on the name invalidates every outstanding capability — without the executor
   needing to know which role or what it meant.
3. **Every failure path returns false.** Registry reads go through low-level `staticcall` so a
   reverting or missing registry surfaces as "not current" rather than bubbling up. There is no
   branch that can return `true` on a resolution error. That is what fail-closed has to mean in
   code.

The live test matrix, run against real Sepolia:

| Test | What it proves |
|---|---|
| `ID-001` | A valid live ENS binding executes |
| `ID-002` | **Revoking an ENS role** regenerates the token id → an unexpired, correctly-signed, never-used capability is rejected, while the name stays registered and owned |
| `ID-003` | An **expired** name fails closed (Foundry fork test against live Sepolia state with `vm.warp`, because the name expires in 2027 and the owner holds neither `ROLE_UNREGISTER` nor `ROLE_RENEW`) |
| `ID-004` | **Transferring the name** to a different owner invalidates outstanding capabilities |
| `ID-005` | Bumping the binding version kills the old identity's authority |
| `ID-006` | A registry read failure **fails closed**, and the same capability succeeds once the outage clears |

`ID-002` is the demonstration that lands: the name is still registered, still owned by the same
address, still unexpired — and one ENS permission change, nothing else, revoked the agent's ability
to spend. That is ENS being *load-bearing*, not decorative.

The Kido line uses ENS for identity, discovery and revocation with the same doctrine, and delegates
financial enforcement to Amane's lease and budget machinery rather than to the identity verifier.
Both hold the same line: **ENS answers who.**

### ENS deployment discovery

A detail worth recording, because it is the sort of thing that silently breaks a demo.

**ENSv2 on Sepolia is a beta, and more than one fully deployed set is in circulation.** They
disagree about addresses. A name registered against one does not resolve against another. Picking
the wrong set does not fail loudly — it produces a name that resolves fine on your machine and not
at all for the person checking it.

So the addresses in Kido's knowledge pack were **discovered and verified on-chain**, not copied from
memory or from a blog post, and the pack records the provenance:

```jsonc
{
  "researchDate": "2026-09-26",
  "status": "VERIFIED_LIVE",
  "statusNote": "contracts verified live on Sepolia (TRACE 2026-09-26); ABIs from ensdomains/contracts-v2@71a3b733"
}
```

The pack also records the **legacy v1 addresses** — `legacyRegistry`, `legacyPublicResolver`,
`legacyNameWrapper` — explicitly, so the v1/v2 distinction is stated rather than assumed by whoever
reads the code next.

`GET /knowledge/drift` re-checks the set against the chain, so a deployment that moves is caught
rather than believed.

One consequence worth understanding: in the execution-time variant described above, **the agent
identity hash commits to the registry address**. Changing which ENS deployment you point at is
therefore itself an identity change, and invalidates outstanding authority. That is correct
behaviour, not an inconvenience — a name in a different registry is a different name.

### ENS file map

| Path | What |
|---|---|
| `Backend/Kido/packages/identity/src/ens.ts` | ENSv2 adapter: resolve, inspect, register, subname, publish, revoke |
| `Backend/Kido/packages/identity/src/core.ts` | `KidoAgentId`, manifest schema, `assertPublicSafe`, `compileIdentityPlan` |
| `Backend/Kido/packages/identity/src/verify.ts` | `verifyBinding` and the nine verdicts |
| `Backend/Kido/packages/identity/abi/*.json` | ENSv2 ABIs from `contracts-v2@71a3b733` |
| `Backend/Kido/knowledge/identity/ens/` | researched facts, deployments, trust profile, limitations |
| `Backend/Kido/scripts/e2e-identity.ts` | dual-chain identity end-to-end |
| `Backend/Kido/scripts/identity-live.ts` | live ENS registration, rotation and revocation |

---

## Sponsor integration — Sui

This is the section to read if you are judging the Sui track.

### Why Sui, specifically

Sui is not a second EVM chain in this design. It is used for four things it is genuinely better at,
and the architecture depends on all four.

**1. The object model makes an account a first-class thing.** An Amane account on Sui is a shared
object holding a `Bag` vault. Ownership, reservations and quarantine are properties of objects, not
entries in a mapping. A reservation is not a bookkeeping row that code must remember to check — it
is a distinct state of a distinct object.

**2. Move's hot-potato pattern makes adapter safety structural.** More on this below, but the short
version: on Sui, Kido can hand an adapter exactly the input it is allowed to have, in a value that
*must* be consumed in the same transaction and *can only* be opened by the adapter holding the right
witness type. There is no equivalent in Solidity; the EVM side achieves a weaker version with a code
hash check.

**3. Native secp256k1 recovery means an Ethereum key can control a Sui account.** The Move core
verifies EIP-712 signatures itself. No bridge, no relayer trust, no second key for the user.

**4. The Sui privacy stack is real.** Seal gives encrypted state with on-chain reader policies —
decryption is granted by a Move function, so the access rule is itself auditable. Nautilus gives a
TEE with on-chain attestation verification. Neither has an Ethereum equivalent with the same
properties.

### The Move core

`Backend/Aname/sui/amane` — package `amane`, core **v5**, published and **frozen**.

```
sources/
  account.move   the shared Account object, vault Bag, policy, leases, tickets, reservations
  eip712.move    EIP-712 struct hashing, identical to the Solidity implementation
  crypto.move    secp256k1 recovery with explicit low-s enforcement
```

The package's `UpgradeCap` has been made immutable — `upgradeAuthority: "FROZEN"`, with the freeze
transaction digest recorded in the deployment manifest. There is no admin key and no upgrade path.
A bug is permanent; fixes ship as a new package with a new id and accounts move explicitly. That is
a deliberate trade: immutability is what makes the on-chain limit a *guarantee* rather than a
promise from whoever holds the upgrade key.

Four superseded package ids are recorded in the manifest with the reason each was abandoned — e.g.
*"budget debited before recipient check: correct outcome, less precise rejection code"*, *"replayable
pause id within an epoch (F-0200 reopened) and refill overflow (F-0211)"*. Frozen, do not use. The
history is in the manifest rather than deleted.

### Ethereum keys on Sui

The single most distinctive property of the Sui integration:

> **You control a Sui account holding tokens by signing with the Ethereum key you already have. No
> Sui wallet. No Sui key. No SUI for gas.**

```
  You (Ethereum key)          Agent (Ethereum key)            Relayer (anyone)
  sign the rules once   ──►   signs "pay 10 AMUSD to X"  ──►  submits it to Sui,
                                                               pays the SUI gas
                                                                     │
                                                                     ▼
                                              Amane account on Sui (holds the tokens)
                                              checks signature + rules, then pays X
```

How it works: every message — `RootPolicy`, `AgentLease`, `ActionIntent`, `PauseAccount`,
`UnpauseAccount`, `RevokeLease`, `Withdraw` — is EIP-712 typed data under the domain
`{ name: "Amane", version: "1", chainId: 11155111 }` with no `verifyingContract`. The Move core
recomputes the struct hash in `eip712.move` and recovers the signer with native secp256k1.

Why no `verifyingContract`: so the *same* signature is valid on Ethereum and on Sui. Replay across
endpoints is prevented by the struct fields themselves — every message binds `accountId`, `chainRef`
and the endpoint `account`, so a signature for the Sepolia endpoint cannot be presented to the Sui
endpoint.

**Signature malleability, handled explicitly.** Signatures are 65-byte `r‖s‖v` with `v ∈ {27, 28}`
and low `s`. Sui's `ecrecover` accepts the high-s twin, so the Move core **rejects it explicitly**.
Without that, every signed action would have a second valid encoding — a replay vector that the EVM
side does not have.

**`chainRef` is asserted by the creator.** Move cannot read the chain id. This is an honest
limitation, stated in the manifest and in the README: clients verify the live chain identifier
(`4c78adac` for Sui testnet) before signing, and every struct also binds the account object id so a
wrong `chainRef` cannot be used to move a real account's funds.

The consequence for Kido: a user who has only ever used Ethereum can own a Sui treasury, and an
agent that only holds an Ethereum key can operate it. The relayer pays SUI gas and holds no
authority whatsoever — it can delay or censor a transaction, and it cannot change the amount, the
recipient, or anything else.

### Hot-potato adapters

This is the Move-specific safety property that has no EVM equivalent.

On Ethereum, the account calls an adapter and the adapter is trusted to do what it says. The
`AdapterRegistry` narrows that trust: it is append-only, the adapter id commits to chain, action
kind, name, version, address **and runtime code hash**, registration refuses any code containing
`DELEGATECALL`, `CALLCODE`, `SELFDESTRUCT` or `SSTORE`, and the account re-checks the code hash on
every use. Good — but still a call into other code.

On Sui, the core does not call the adapter. It creates an **`ActionTicket<W, In>`** (or
`BridgeTicket<W, In>`) — a hot potato:

- It has no `drop`, `store` or `key` ability. It **must** be consumed in the same transaction, or
  the transaction aborts. Funds cannot be left in limbo.
- It is parameterised by a witness type `W`. Only the adapter package that can construct `W` can
  open it. The adapter id commits to `(chain, kind, name, version, witnessType)`, and the witness
  type embeds its package id.
- It carries the exact input. Not an allowance, not an approval — the coin itself, in the amount the
  policy permitted.

So an adapter cannot take more than it was handed, cannot be substituted by a different package, and
cannot leave the transaction half-done. That is enforced by the type system, before any logic runs.

The known limitation is recorded honestly: Sui adapter ids derive from the witness **type name**,
which an upgrade would not change — so adapter packages must be published immutable, and that is
checked off-chain. All of them are frozen, with freeze digests in the manifest.

A second limitation, also recorded: **Sui adapters are bound to a core version's `Account` type.**
v4 adapters do not operate v5 accounts. So the Cetus pinned swap exists as two separate deployments,
one built against v4 and one against v5, each with its own package id and its own freeze digest.

### Cetus CLMM

`Backend/Aname/sui/amane_cetus`, `amane_cetus_pinned`, `amane_cetus_pinned_v5`

Cetus is the concentrated-liquidity DEX Kido uses for `SWAP` on Sui. Two variants exist:

| Variant | Pool |
|---|---|
| **Cetus CLMM Swap** | pool passed per call, not pinned on-chain |
| **Cetus CLMM Pinned Swap** | pool pinned **in the adapter package itself** |

The pinned variant is the one Kido selects. The pool id
`0x3f0397909cce1ded2d1502dbc2ae9e2b37170026083f42bd5a85bccf55947eac` is fixed at publish time and
the package is frozen, so an agent cannot be steered into a different — possibly attacker-created —
pool with the same coin types. Pool substitution is a real attack on any DEX integration that takes
the pool as a parameter.

The swap is a **direct CLMM flash swap**, and critically the **core measures the output**, not the
adapter:

```
output measured by the core against the effective minimum (owner floor ∧ intent minAmountOut)
```

An adapter that lies about how much came back does not get away with it. The account compares the
measured delta against the floor. Price floors come from the owner-signed policy (`swapFloors` in
Kido's blueprint, `PriceMode.TESTNET_FIXED` in Amane) — minimum output per unit of input, set by
the owner, not read from an oracle. Oracle price modes are stated as future work rather than
implied.

Upstream Cetus bindings — package, type origin, global config, pools table, Move dependency revision
(`CetusProtocol/cetus-contracts packages/cetus_clmm rev testnet-v0.0.2`) — are all pinned in the
deployment manifest. **Upstream protocols are mutable**, so adapters pin their bindings and **fail
closed on drift**, leaving funds in the account rather than proceeding against a changed protocol.

### SuiNS

`Backend/Kido/packages/identity/src/suins.ts`

SuiNS is the Sui identity provider, and the adapter is a good example of Kido's honesty discipline,
because SuiNS is **not** ENS and the adapter says so rather than papering over the difference.

What works, live, verified with `@mysten/suins 2.0.12` over gRPC:

| Capability | Status |
|---|---|
| `RESOLVE` | live — name → target address |
| `REVERSE_RESOLVE` | live — address → default name |
| `ADDRESS_RECORD` | live |
| `EXPIRY` | live — `expirationTimestampMs` from the name record |

What does not, and why:

- **Records are limited** to `avatar`, `content_hash` and `walrus_site_id`. There is no free-form
  text record, so the `KidoAgentId ↔ name` mapping **cannot** be published on SuiNS the way it is on
  ENS. The manifest lives on the ENS side; the SuiNS binding is listed *inside* that manifest, and
  the Sui side is verified by reverse resolution to the expected address.
- **Registration is `BLOCKED_ENV`.** It needs test USDC/NS or a Pyth access token
  (blocker `BC-SUINS-1`). `register()` returns a `BLOCKED_ENV` receipt with that exact detail —
  it does not throw, and it does not pretend.
- The `@mysten/suins` SDK still references subnames v1 while v2 is live (finding `F-0406`), and
  it throws for unknown names rather than returning null — the adapter catches that and reports
  "not registered" rather than propagating an SDK quirk as a failure.

`verifyBinding` applies the SuiNS name rule `^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+sui$` and,
because there is no manifest record to read, verifies through the address path: the resolved target
must be one of the agent's advertised accounts.

**One `KidoAgentId`, two names, neither of them the root.** `scripts/e2e-identity.ts` runs exactly
this: a dual-chain agent whose ENS name and SuiNS name both point at the same `KidoAgentId`, and
whose manifest lists both bindings. Neither chain's name service is the identity. That is the whole
reason `KidoAgentId` exists as a separate thing.

### Seal

`Backend/Kido/move/kido_seal/sources/reader_policy.move` · `@mysten/seal 1.4.16` · package v6
(testnet) · **`TESTNET_LIVE`**

Seal is decentralised secrets management for Sui: encrypted state whose decryption is gated by an
**on-chain reader policy**. Kido uses it for `ENCRYPTED_STATE` and `SECRET_ACCESS_CONTROL`.

Why it matters here: Kido's backend must be able to *hold* an agent's encrypted state without being
able to *read* it. A private strategy parameter, a threshold, an API credential — these persist
between runs, so they cannot live only in an ephemeral enclave, and they must not sit in plaintext
in Kido's store if the user said to hide them from the backend.

Seal resolves that: the ciphertext persists anywhere, and the decryption key is released by key
servers only to a reader the **Move policy** approves. The access rule is a published Move function,
so the rule itself is auditable, and changing who may read is an on-chain transaction with a
receipt.

Kido ships `kido_seal::reader_policy` as its own Move module, with tests, plus two live scripts:

- `scripts/seal-live.ts` — encryption, reader policy changes, decryption by an approved reader.
- `scripts/seal-regression.ts` — the **cached-key regression**: after a reader is removed from the
  policy, a previously issued key must not continue to work. This is the failure mode that makes a
  naive integration useless, so it has a dedicated live test.

### Nautilus

`Backend/Kido/move/kido_nautilus/sources/decision.move` · **`IMPLEMENTED_LOCAL`**

Nautilus is Sui's TEE framework: run a computation inside an enclave and verify the attestation
on-chain. Kido uses it for `CONFIDENTIAL_COMPUTE` and `VERIFIABLE_COMPUTE` — a decision computed
over private inputs where only the *decision* is disclosed, never the inputs.

The on-chain half is written and tested: `kido_nautilus::decision` verifies an enclave's signed
decision against a registered enclave identity, with test vectors.

The status is **`IMPLEMENTED_LOCAL`, not `LIVE_ATTESTED`**, and the distinction is stated
everywhere it appears. There is no attested enclave host in this environment, so the enclave tier
runs locally and unattested. The registry's status meanings make the difference explicit:

```
IMPLEMENTED_LOCAL: "built and tested locally (unit or local-chain tests); not live on a testnet,
                    not attested, and not a simulated stand-in"
LIVE_ATTESTED:     "live with hardware or protocol attestation verified"
```

The privacy compiler knows the difference too. A private value whose `plaintextBoundary` is
`APPROVED_ENCLAVE` and which must be hidden from `NORMAL_KIDO_BACKEND` requires
`VERIFIABLE_COMPUTE` — attestation is precisely what lets a blind backend trust a result it cannot
recompute. Without a live attested host, that value compiles to `SATISFIED_PLANNING_ONLY`, with the
blocker named, rather than to `SATISFIED`.

### Wormhole: Sui ⇄ Ethereum

`Backend/Aname/sui/amane_wormhole` · `Backend/Aname/evm/src/adapters/WormholeBridgeAdapter.sol`
· **`TESTNET_LIVE`**

This is the most technically involved part of the Sui integration, and the one that makes
*"protect my Aave position on Ethereum using liquidity on Sui"* a real sentence rather than a slide.

**The principle:** a bridge moves messages and assets. **It never decides what may happen on
arrival.**

A cross-chain move is split into two independently authorised legs:

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

`DestSpec` commits to what may happen on arrival, and is hashed **identically in Solidity, Move and
TypeScript**:

```
keccak256(abi.encode(keccak256("AMANE_DEST_SPEC_V1"), actionKind, adapterId, recipient,
                     keccak256(recipientLabel), asset, minArrival, deadline))
```

Three implementations of one hash, kept in agreement by golden vectors in
`Backend/Aname/vectors/` that TypeScript, Solidity **and** Move all check against. `npm run
vectors` regenerates them and the diff must be empty.

**The arrival lifecycle:**

```
AVAILABLE ──► RESERVED_FOR_INTENT ──► SPENT
                     │
                     └─ deadline passes ──► QUARANTINED ──► withdrawn by root threshold
                                                            to a pinned recovery destination
arrival whose destination can no longer run ─────────► QUARANTINED
```

- A reservation can only be spent by an action whose lease, kind, adapter, recipient and asset match
  it, up to the amount that arrived. **Ordinary actions — even under the same lease — cannot touch
  reserved or quarantined funds.**
- A reserved `BRIDGE` commits to its *own* next destination in `planHash`, so funds can go out and
  come back under the same guarantees. Round trips work.
- **Recovery is refused while the committed destination can still execute.** `recoverArrival` /
  `redeem_to_recovery` only accept once the deadline has passed, or the lease expired or was
  revoked. Nobody can divert a deliverable arrival — not the agent, not the relayer, not the owner.
- Root recovery (`withdraw`) may take available and quarantined funds, **never a live reservation**.

The paired deployment is pinned in both directions: the Sui bridge object pins the EVM adapter
address once via a one-time `SetupCap`, and the EVM adapter pins the Sui adapter's `EmitterCap` id.

```
Sui emitterCap  0xc245eb1df3ba85fd8b38e1b9bddc1e7ff7a80df49793bfb477969da7cc368087
Sui bridge      0xf3ddf8b59325f108f57ac07ed2146824b5bf9f4232ca616fc5f4749c5bcec8f2
EVM adapter     0x88b1953f16c06976fcb6575aacb317a5917db7a6
```

**Attacks exercised against the live contracts**, both chains: bridge to an unpinned endpoint,
over-cap bridge, forged agent signature, substituted destination spec, VAA presented for a different
intent, VAA replay, spending reserved funds outside the reservation, reserved funds sent to an
attacker endpoint, over-reservation, different action on reserved funds, paying a reserved arrival
to someone else, double spend of a reservation, late delivery to an expired destination, premature
recovery, and an agent attempting to withdraw quarantined funds.

Limitations stated honestly: Wormhole testnet runs a **single guardian**; Sepolia-originated
transfers are signed only after Ethereum finality (**~15 minutes**); VAAs are redeemed by Kido's
relayer. Sui core v5 executes reserved `PAY` and `BRIDGE` — a reservation committed to a Sui `SWAP`
can only expire into quarantine.

### Sui file map

| Path | What |
|---|---|
| `Backend/Aname/sui/amane/sources/account.move` | the Account shared object, policy, leases, tickets, reservations |
| `Backend/Aname/sui/amane/sources/eip712.move` | EIP-712 struct hashing, matching Solidity |
| `Backend/Aname/sui/amane/sources/crypto.move` | secp256k1 recovery, explicit low-s enforcement |
| `Backend/Aname/sui/amane_cetus_pinned_v5/` | Cetus CLMM pinned swap adapter, v5, frozen |
| `Backend/Aname/sui/amane_wormhole/` | Wormhole bridge adapter, frozen |
| `Backend/Aname/sui/amane_tokens/` | AMUSD / AMSUI testnet demo tokens with open faucets |
| `Backend/Aname/packages/sdk/src/sui.ts` | `AmaneSuiEndpoint` — the TypeScript relayer |
| `Backend/Kido/packages/identity/src/suins.ts` | SuiNS adapter |
| `Backend/Kido/move/kido_seal/` | Seal reader policy Move module |
| `Backend/Kido/move/kido_nautilus/` | Nautilus decision verifier Move module |
| `Backend/Kido/scripts/e2e-sui.ts` | Sui trading agent end-to-end plus attacks |
| `Backend/Kido/scripts/e2e-crosschain-rescue.ts` | Sui liquidity rescues an Ethereum Aave position |

---

## Amane: the authority layer

`Backend/Aname`

Amane is where "bounded" stops being an adjective and becomes a contract.

### Three signed objects

| Object | Signed by | Binds |
|---|---|---|
| `RootPolicy` | root controllers (threshold) | per endpoint: allowed action kinds; adapters `(id, name, version)`; assets with `maxPerAction / maxPerEpoch / maxTotal`; pinned recipients and beneficiaries **with labels**; owner swap floors; recovery destinations; lease issuers with aggregate caps; parent policy hash; activation deadline |
| `AgentLease` | a root controller, or a listed lease issuer — **never the agent** | agent key; validity window; activation deadline; a **subset** of kinds, adapters, assets, caps, recipients and beneficiaries per endpoint |
| `ActionIntent` | the agent | account id, chain ref, endpoint, policy version, lease, nonce, kind, adapter id/name/version, asset in/out, amount, min out, recipient + label, deadline, plan hash, plan step |

Plus `PauseAccount` (any one controller), `UnpauseAccount` (threshold), `RevokeLease` (a controller
or the lease's issuer) and `Withdraw` (threshold, to a pinned recovery destination only).

**The agent can never widen its own authority**, because the lease is signed by someone else and the
chain checks that the lease is a subset of the policy and the action is a subset of the lease.

### The enforcement pipeline

Every action goes through the same ordered checks, on-chain, before value moves:

1. **Liveness** — not paused; bound to this account id, chain ref and endpoint.
2. **Lease** — active, same policy version, inside its window; action deadline not passed.
3. **Signature** — recovers to the lease's agent; nonce unused, then marked used.
4. **Kind / adapter / asset** — allowed by lease **and** policy; adapter id re-derived from the
   registry (EVM: address + **code hash**) or witness type (Sui); name and version match.
5. **Recipient** — `PAY`/`BRIDGE`: pinned in lease and policy **with the policy's label**;
   `REPAY`: beneficiary pinned; `SWAP`: output must return to the account.
6. **Budgets** — lease, root and issuer buckets debited. **Only now** — so a rejection names the
   real reason rather than a budget error masking a recipient error.
7. **Execution and measurement** — exact input moved; output, delivery or debt reduction **measured
   by the core** against the effective minimum.

Budgets are token buckets: `maxPerEpoch` is burst capacity refilled linearly over `epochSeconds`, so
spend in any window of length *W* is at most `maxPerEpoch × (1 + W / epochSeconds)`. That bound is
stated because a naive reading of "per hour" gives you double it at a window boundary.

### Outcomes

```ts
type AmaneOutcome =
  | { kind: 'EXECUTED'; tx }
  | { kind: 'REJECTED_BY_AMANE'; code }      // e.g. 1400 AMANE_BUDGET_PER_ACTION
  | { kind: 'NONCE_CONSUMED' }               // settle from chain events; never retry blindly
  | { kind: 'OPERATIONAL_FAILURE' }          // RPC, gas, funding
```

Every mutating call **simulates first**, so a policy rejection costs no gas. Rejection codes are
numeric and stable across both chains — `1310 AMANE_ACTION_RECIPIENT_NOT_ALLOWED`,
`1400 AMANE_BUDGET_PER_ACTION`, `1802 AMANE_XCHAIN_SPEC_MISMATCH` — defined once in
`packages/core/src/codes.ts` and generated into Move and Solidity.

`OPERATIONAL_FAILURE` is never reported as a policy decision. An RPC outage is not a denial.

### Test counts

| Suite | Tests |
|---|---|
| Foundry (unit, cross-chain, Wormhole, adversarial, invariants) | 178 |
| Move (account, adversarial, cross-chain, golden parity) | 126 |
| `@amane/core` (hashing, codes, subset rules, cross-chain) | 55 |
| `@amane/sdk` (outcome classification) | 10 |

---

## Privacy

`packages/privacy`

Privacy in Kido is a compiler, not a checkbox. You state what must be hidden and from whom; the
compiler works out which capabilities that implies, selects providers that have proven them, and
reports contradictions rather than resolving them silently.

A `PrivateValueSpec`:

```ts
{
  id, description,
  kind:               SECRET_STORAGE | PRIVATE_INPUT | PRIVATE_API_CREDENTIAL |
                      PRIVATE_API_RESPONSE | PRIVATE_STRATEGY | PRIVATE_POLICY |
                      CONFIDENTIAL_COMPUTE | VERIFIABLE_COMPUTE | ENCRYPTED_STATE |
                      PRIVATE_MODEL_CONTEXT,
  hiddenFrom:         (PUBLIC_CHAIN | OTHER_USERS | AI_AGENT | NORMAL_KIDO_BACKEND |
                       CLOUD_HOST | PROTOCOL_ADAPTER | EVERYONE_EXCEPT_APPROVED_ENCLAVE)[],
  plaintextBoundary:  USER_DEVICE | KIDO_SECRET_STORE | APPROVED_ENCLAVE | DON | NONE,
  allowedDisclosure:  FULL_RESULT | REDACTED_RESULT | BUCKETED_RESULT |
                      BOOLEAN_RESULT | DECISION_ONLY | COMMITMENT_ONLY,
  failurePolicy:      FAIL_CLOSED | SKIP_ACTION | NOTIFY_OWNER,
}
```

`requiredCapabilities(v)` returns either the capability set or a **contradiction in plain English**:

- *"plaintext in Kido's secret store contradicts hiding it from Kido's backend or cloud host"*
- *"a value hidden from the AI agent cannot be model context"*
- *"the agent needs this value at runtime, but plaintext may only exist on your device"*
- *"a value with no plaintext anywhere can only be used as a commitment"*

Provider mapping:

| Need | Provider |
|---|---|
| Encrypted state persisting between runs, backend blind | **Seal** (`ENCRYPTED_STATE`, `SECRET_ACCESS_CONTROL`) |
| Decision over private inputs, only the decision disclosed | **Nautilus** (local tier) or **Chainlink CRE** |
| Attestation so a blind backend can trust a result | `VERIFIABLE_COMPUTE` — Nautilus, when attested |

The reasoning is written into the compiler:

```ts
// Kido's backend cannot hold a secret it must not see, and an enclave is ephemeral: the value
// persists encrypted, with decryption granted only to the attested enclave.
if (blindBackend && PERSISTENT_SECRET.has(v.kind)) caps.push("SECRET_ACCESS_CONTROL");
```

Values compile to `SATISFIED`, `SATISFIED_PLANNING_ONLY` (the design is sound; a provider is not
live here) or `UNSATISFIABLE` (the requirement contradicts itself), each with reasons and the trust
profiles of the selected providers.

On top sits the **leak guard** (`guard.ts`) and `npm run canary-scan`, which plants a canary private
value and fails if it reaches the blueprint, the model context, an agent's context or the
repository.

---

## Identity, authority and discovery are three different things

The idea the whole system is organised around, stated once, plainly:

| | Question | Where it lives | Revoked by |
|---|---|---|---|
| **Identity** | *Who is this agent?* | `KidoAgentId` in the blueprint | a new blueprint revision |
| **Discovery** | *How do I find and check it?* | ENS records, SuiNS target | clearing records / burning the subname |
| **Authority** | *What may it spend?* | Amane `RootPolicy` + `AgentLease`, on-chain | `revokeLease`, `pause`, lease expiry |

Three separate things, three separate revocation levers, three different parties.

Why it matters, concretely:

- **Clearing an ENS record does not stop money moving.** If it did, whoever controls the name would
  control the treasury, and an ENS compromise would be a financial compromise.
- **Revoking a lease does not delete the agent's identity.** The agent still exists, is still
  discoverable, and still has a history. It simply cannot spend.
- **A new blueprint revision does not silently change what is on-chain.** It changes the commitment
  hash, which makes the published record detectably `STALE`, and the new authority needs a new
  signature.

Most designs collapse at least two of these into one, and every collapse is a privilege escalation
path.

---

## The frontend

`frontend/` — Next.js 15.1.12, React 19, App Router.

```
app/page.tsx                 the landing: a Three.js scene, protocol marks on a lemniscate
app/new/                     agent creation — seven steps, chat left, work right
app/projects/[projectId]/    the workbench: 21 pages
components/studio/           shell, panels, wallet and signing surfaces
lib/studio/                  API client, event stream, workbench state
public/styles/               stylesheets in load order; landing.css last
```

The workbench is organised as an activity rail (Build · Design · Test · Code · Deploy · Operate ·
Integrate · Reports) with a contextual explorer, a centre pane, a bottom panel and an assistant
sidebar.

Three things worth knowing:

**The API is same-origin.** `next.config.mjs` rewrites `/api/*` to `127.0.0.1:4310` server-side, so
the browser only ever talks to its own origin. There are no CORS headers anywhere in the stack, and
setting a public API URL would break that by sending the browser cross-origin instead.

**The build event stream is persisted before it is broadcast.** A client that subscribes late
replays the same sequence a client present from the start saw, so both end in identical states.
Nothing needs to be open when a build starts.

**The scene engine holds direct DOM references.** It resolves nodes by selector at construction and
keeps them, so destroying or remounting those nodes breaks it rather than re-initialising it.
Sections that are not part of the story are hidden, not deleted; the wallet runtime mounts as a
sibling rather than a wrapper; moving between landing and workbench is a document navigation.

### Design system

- **Type:** Neue Montreal (UI), PP Editorial New (display serif), **IBM Plex Mono** (labels, badges,
  counts, thresholds — tabular figures, so a column of dollar limits aligns on the digit).
- **Palette:** near-black `#0a0a0d` and cream `#fef1d0`, plus one brand colour, vermilion `#FF5C35`,
  deliberately off every hue the verdict palette owns (green / amber / red / violet / cyan) so it can
  never be mistaken for a status. It carries structure and intent only: section index, focus ring,
  active rail marker, unresolved-row edge, and the one committing button per page.
- **Badges are marks, not pills** — a rule in the tone colour with the word beside it. The filled
  chip is reserved for one hero status per page.
- **Sections are numbered editorial heads** — a mono index in the brand colour, the heading in the
  display serif at reading size, via a CSS counter so no page passes a number.
- **A badge that reads the same on every row carries no information** — the doctrine applied
  throughout. Status is marked only where it is an exception.

---

## Live testnet scenarios

All run against Sepolia and Sui testnet with **disposable keys**, and write evidence **outside** the
repository.

| Script | Scenario |
|---|---|
| `e2e-ethereum-a.ts` | Aave health factor falls → agent repays a **pinned beneficiary's** debt through Amane |
| `e2e-ethereum-a-attacks.ts` | The same agent, attacked: over-cap, unpinned beneficiary, forged signature, replayed nonce — each rejected **on-chain** with its code |
| `e2e-sui.ts` | Sui trading agent: allocation drift → swap through the **pinned** Cetus pool; attack variants |
| `e2e-identity.ts` | One `KidoAgentId` bound through ENS (live) and SuiNS (live reads); neither name is the root |
| `identity-live.ts` | Live ENS registration, subname issuance, record publication, rotation, revocation |
| `seal-live.ts` | Seal encryption, reader-policy change, decryption by an approved reader |
| `seal-regression.ts` | **Cached-key regression** — a removed reader's previously issued key must stop working |
| `cre-receiver-live.ts` | `KidoCreReceiver` on Sepolia, through a simulated forwarder (stated as simulated) |
| `e2e-crosschain-live.ts` | Kido's cross-chain engine drives a **Sui → Sepolia → Sui round trip** over Wormhole; both reservations enforced on-chain |
| `e2e-crosschain-rescue.ts` | **Cross-chain position rescue**: health factor below target → Cetus swap on Sui → Wormhole → reserved swap into Aave USDC → `REPAY` on Ethereum |

`e2e-crosschain-rescue.ts` is the demo that shows the whole thesis in one run: a deterministic
monitor on Ethereum, liquidity on Sui, one signed authority spanning both, a bridge that cannot
choose what happens on arrival, and an on-chain policy that would have rejected any deviation.

From the Amane side, `packages/sdk/scripts/live-bridge-roundtrip.ts` additionally proves the
**failure** paths live: a reserved `BRIDGE` with a three-minute destination deadline expires in
flight, can only be quarantined, and is withdrawn by the root 2-of-2 to the pinned recovery address.

---

## Running it

### Prerequisites

Node ≥ 22, Foundry, `sui` CLI ≥ 1.80 (older CLIs cannot reach testnet — the public JSON-RPC is shut
down).

### Backend

```bash
cd Backend/Kido
npm ci
npm run build
npm test

npm run kido:api        # HTTP API on 127.0.0.1:4310
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local    # WalletConnect project id
npm run dev                   # http://localhost:3000

npm run build                 # production build
npm run typecheck             # tsc --noEmit
```

### Environment

Configuration is **environment-only**. Only names live in the repository, never values.

| Tier | Needs | Without it |
|---|---|---|
| Unit / mock integration | nothing | runs |
| Live model (interview, agent chat, live eval) | `OPENAI_API_KEY` | `BLOCKED_ENV` |
| Sepolia live scripts | `SEPOLIA_RPC_URL`, `FUNDER_PRIVATE_KEY` or `KIDO_OPERATOR_KEY` (gas only), `KIDO_DEMO_KEYS` | `BLOCKED_ENV` |
| Sui live scripts | `KIDO_DEMO_KEYS`, `KIDO_SUI_SIGNER_KEY` for Seal | `BLOCKED_ENV` |
| Cross-chain scripts | the above plus `KIDO_XCHAIN_STATE`, `KIDO_EVM_BALANCE_FLOOR` | `BLOCKED_ENV` |

> **The API takes controller, issuer and agent *addresses* — never keys.** Owner controller keys are
> never given to Kido. Script keys are disposable testnet keys held outside the repository.

---

## HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /projects` | Start a project from an objective |
| `GET /projects/:id/next` | The next interview question |
| `POST /projects/:id/answer` | Answer it |
| `POST /projects/:id/edit` | Edit a confirmed requirement → new revision |
| `GET /projects/:id/unresolved` | Everything still unknown |
| `GET /projects/:id/blueprint` | The current blueprint revision |
| `POST /projects/:id/finalize` | Freeze a revision |
| `POST /projects/:id/security-review` | Run the review gate |
| `POST /projects/:id/simulate` | Run declared scenarios and attacks |
| `POST /projects/:id/build` | Build the runtime |
| `GET /projects/:id/status` | Lifecycle state |
| `POST /projects/:id/introspect` | Ask the agent about itself |
| `GET /projects/:id/self-model` | The compiled self-model |
| `GET /projects/:id/context/:role` | The exact context a given agent role receives |
| `GET /registry` · `GET /registry/:id` | Providers and their implementation status |
| `GET /knowledge/drift` | Knowledge packs that no longer match the chain |

`GET /projects/:id/context/:role` deserves a note: it returns **exactly** what a model-facing agent
is given, so you can check for yourself that a private value is not in it. Auditability of the
model's inputs is a feature, not a debug endpoint.

---

## CLI

```bash
npm run kido -- create "Build me a treasury agent on Ethereum that pays my supplier"
npm run kido -- next <project>
npm run kido -- answer <project> "only recipients I approve"
npm run kido -- finalize <project>
npm run kido -- security-review <project>
npm run kido -- simulate <project>
npm run kido -- build <project>
npm run kido -- ask <project> "What are you allowed to do?"
```

---

## Honesty machinery

A list of the mechanical checks that keep claims aligned with reality, because in this category the
difference between a working system and a convincing demo is exactly this list.

In `Backend/Kido`:

```bash
npm test                  # all workspaces
npm run typecheck
npm run privilege-audit   # model-facing agents cannot reach keys; only operator scripts read them
npm run canary-scan       # a private value never reaches the blueprint, the model, agent context or the repo
npm run secret-scan       # no secret material tracked
```

In `Backend/Aname`:

```bash
npm test                  # core + sdk (vitest), evm (forge), sui (sui move test)
npm run vectors           # golden vectors regenerate identically across TS, Solidity and Move
```

Knowledge-pack drift is served by the API rather than a script: `GET /knowledge/drift`.

- **`privilege-audit`** statically proves that packages containing model-facing agents cannot import
  anything that reads a key. The separation is enforced, not documented.
- **`canary-scan`** plants a canary private value through a full interview and fails if it appears
  anywhere it must not.
- **`vectors`** (Amane) regenerates the shared golden vectors; **the diff must be empty**. If the
  TypeScript, Solidity and Move implementations of a hash disagree, this is what catches it.
- **`GET /knowledge/drift`** re-checks each knowledge pack against the chain, so a pack that has
  gone stale is caught rather than believed.
- **The registry** never collapses `SIMULATED` into `TESTNET_LIVE`, or `IMPLEMENTED_LOCAL` into
  `LIVE_ATTESTED`.
- **`AI_USAGE.md`** states where AI was used, and — more usefully — what it does **not** decide:
  financial authority, confirmed requirements, or provider status.

---

## Threat model

Assumption: **the agent may be wrong, prompt-injected, stale or fully compromised.** Relayers, RPCs
and bridges are untrusted.

| Actor | Can | Cannot |
|---|---|---|
| **Agent key** | sign actions inside its lease | sign leases, change policy, withdraw, pick arbitrary targets or recipients, spend reserved funds outside their reservation |
| **Relayer / executor** | submit, delay, censor | alter a signed action, broaden a lease, redirect output, take custody |
| **Lease issuer** | issue leases within its aggregate caps | exceed caps smaller than the root policy's |
| **Bridge / transport** | delay, fail to deliver | choose the destination action, recipient, asset or amount; replay; tamper with the payload |
| **Kido backend** | design, build, relay, observe | hold a root controller key; widen authority; read a value marked hidden from it |
| **Model** | propose typed actions; answer questions | authorise anything; change a confirmed requirement; change provider status |
| **ENS name owner** | rewrite discovery records | grant, change or revoke financial authority |
| **Root controllers** | everything | *out of scope if the threshold is fully compromised* — mitigated by threshold signing, pinned recovery destinations and admin-free code |

---

## Known limitations

Stated plainly, because a limitation you have written down is a design decision and one you have
not is a bug waiting to be found by someone else.

**Scope**
- Not audited. Testnet assets only, on Ethereum Sepolia and Sui Testnet.
- Immutable Sui packages mean bugs are permanent; fixes ship as new versions and accounts move
  explicitly.

**Cross-chain**
- **Revocation is not atomic across chains.** Until a revoke lands on every endpoint, an agent key
  can spend the remaining per-endpoint budget. Mitigation: short leases, small budgets.
- Worst-case exposure across chains is the **sum** of per-endpoint limits, not the max. Kido
  computes and displays `crossChainTotal` for this reason.
- Wormhole testnet runs a **single guardian**. Sepolia-originated transfers wait for Ethereum
  finality (~15 minutes). VAAs are redeemed by Kido's relayer.
- A cross-chain rescue is bounded by lease caps and may restore a health factor only **partially**.

**Sui**
- `chainRef` is asserted by the account creator; Move cannot read the chain id. Clients verify the
  live chain identifier before signing, and every struct also binds the account object id.
- Sui adapter ids derive from the witness **type name**, which an upgrade would not change — so
  adapter packages must be published immutable, checked off-chain. All are frozen.
- Sui adapters are bound to a core version's `Account` type; v4 adapters do not operate v5 accounts.
- Sui core v5 executes reserved `PAY` and `BRIDGE`; a reservation committed to a Sui `SWAP` can only
  expire into quarantine.

**Identity**
- **SuiNS registration is `BLOCKED_ENV`** — it needs test USDC/NS or a Pyth access token
  (`BC-SUINS-1`). Reads are live.
- SuiNS records are limited to `avatar`, `content_hash`, `walrus_site_id`, so the manifest cannot be
  published there; the Sui binding is verified through the address path instead.
- The `@mysten/suins` SDK still references subnames v1 while v2 is live (`F-0406`).
- ENSv2 on Sepolia is a **beta**. Three deployments are in circulation and disagree; Kido pins the
  published set and records the alternates.

**Privacy**
- **Nautilus runs as a local, unattested tier** — `IMPLEMENTED_LOCAL`, never `LIVE_ATTESTED`.
- **Chainlink CRE runs through a simulated forwarder** — `SIMULATED`, blocked on an interactive CRE
  login (`BLOCKED_AUTH`).

**Protocols**
- Upstream protocols are mutable. Adapters pin their bindings and **fail closed on drift**, leaving
  funds in the account.
- Price floors exist only in `TESTNET_FIXED` mode (owner-set per pair). Oracle price modes are
  future work.
- A single RPC can lie about receipts. The SDK can land rejections on-chain, but a client trusting
  one RPC cannot detect false receipts.

**Transport**
- LayerZero is `BLOCKED_UPSTREAM` — its Sui SDK requires the retired JSON-RPC.

---

## Deployed addresses

Full manifest: `Backend/Aname/deployments/testnet.json`. The SDK and every script read from it
rather than from constants, so there is one place where an address can be wrong.

### Ethereum Sepolia — chain 11155111

| | Address |
|---|---|
| `AdapterRegistry` | `0xE268eB1B45efFf327509c65d7CBc0ec9e26Eee02` |
| `AmaneAccountExt` (shared, v3) | `0x0a2feab8333c866251b2036fc86e4f35bac0401a` |
| Transfer Pay adapter | `0xEAcCFbdE3c36558a4C9551a82356D8c9Ada96947` |
| Aave v3 Repay adapter | `0xb58c014c1fd617ee256bbf08ae11c294f6f168ca` |
| Uniswap v3 Swap adapter | `0xa234ddbe6706ef80b053009b21fc47995649a581` |
| Wormhole Bridge adapter | `0x88b1953f16c06976fcb6575aacb317a5917db7a6` |
| Aave v3 Pool | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| Uniswap v3 SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |
| Wormhole core / token bridge | `0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78` / `0xDB5492265f6038831E89f495670FF909aDe94bd9` |

Upgrade authority: **none**. Accounts are deployed per account by a non-upgradeable constructor.

### Sui Testnet — `4c78adac`

| | Id |
|---|---|
| `amane` core v5 | `0x700e76aafce5b10854767a1f6d553145cd345914809ab88596d441b0c334df88` |
| Cetus pinned swap (v5) | `0x4b2dcb1486e72e3d2dbef6da86f4a2b80f3251bf36f8cf7028056a5830334c7f` |
| Wormhole bridge (v5) | `0x615e2b23ffc8ba04e5428e6232b11bc259e221d3774ae5847796660a2940d14b` |
| Demo tokens (AMUSD / AMSUI) | `0xfbd965e0d52d45341d8bdd525d0fae835a5f9cad11c8194e08f1bd6f3405bee6` |
| Cetus CLMM | `0x6bbdf09f9fa0baa1524080a5b8991042e95061c4e1206217279aec51ba08edf7` |
| Cetus pool (AMUSD/AMSUI) | `0x3f0397909cce1ded2d1502dbc2ae9e2b37170026083f42bd5a85bccf55947eac` |
| Wormhole core | `0x21473617f3565d704aa67be73ea41243e9e34a42d434c31f8182c67ba01ccf49` |

Upgrade authority: **FROZEN**, with freeze digests recorded per package.

### ENSv2 Sepolia (beta)

| | Address |
|---|---|
| `ETHRegistry` | `0x657ea849311d3d5823348dded7c2aaafb3ede09e` |
| `ETHRegistrar` | `0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca` |
| `UniversalResolverV2` | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |
| `VerifiableFactory` | `0x9e726eb570beb6bceb495ab8cda7df517d4e841c` |
| `PermissionedResolverImpl` | `0x14f09fd05d4585759e54844dc9b00147131cf243` |
| `UserRegistryImpl` | `0xa80338aaa8d23831cea25e858d1774534abb0263` |
| `MockUSDC` | `0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e` |

ABIs from `ensdomains/contracts-v2@71a3b733`. Verified on-chain; see
`Backend/Kido/knowledge/identity/ens/`.

### SuiNS Testnet

| | Id |
|---|---|
| `suins` | `0x300369e8909b9a6464da265b9a5a9ab6fe2158a040e84e808628cde7a07ee5a3` |
| core (latest) | `0x40eee27b014a872f5c3330dcd5329aa55c7fe0fcc6e70c6498852e2e3727172e` |
| subnames (latest) | `0xf0c12144cb6e237a28b75368fd7a03fb2c484923a4b471da96e059f9e34edce7` |

### Seal Testnet

| | Id |
|---|---|
| package (latest) | `0xdccbeb87767be2b2346af5575eb139807205e4c23ec53dc616f951fe1d814112` |
| package (original) | `0x4614e5da0136ee7d464992ddd3719d388ae2bfdb48dfec6d9ad579f87341f2e1` |

---

## Glossary

| Term | Meaning |
|---|---|
| **KidoAgentId** | The root identity of an agent: `kido:agent:` + 16 Crockford-base32 characters. Not a name, not an address. Names are bound to it. |
| **Blueprint** | The canonical, versioned, hashed description of an agent. The single source of truth. |
| **Blueprint commitment** | The hash of a blueprint revision, published in the ENS `agent-context` record so a stale advertisement is detectable. |
| **RootPolicy** | The owner-signed, on-chain authority ceiling. Threshold-signed. |
| **AgentLease** | A short-lived, revocable subset of the root policy, signed by a controller or a listed issuer — never by the agent. |
| **ActionIntent** | One EIP-712 action the agent signs. It names the adapter, asset, amount, recipient and deadline. |
| **DestSpec** | What may happen to funds on arrival after a bridge. Committed by the source intent's `planHash`. |
| **Reservation** | Arrived cross-chain funds locked to the one intent that sent them. |
| **Quarantine** | Arrived funds whose destination can no longer run. Recoverable only by the root threshold, to a pinned address. |
| **Hot potato** | A Move value with no `drop`/`store`/`key`, which must be consumed in the same transaction. |
| **Witness type** | The Move type that identifies an adapter. Embeds its package id; the adapter id commits to it. |
| **Adapter id** | EVM: commits to chain, kind, name, version, address and **runtime code hash**. Sui: commits to chain, kind, name, version and **witness type**. |
| **Token bucket** | The budget model: `maxPerEpoch` burst capacity refilled linearly over `epochSeconds`. |
| **Implementation status** | What an integration has *proven*: `NOT_IMPLEMENTED` → `IMPLEMENTED_LOCAL` → `SIMULATED` → `TESTNET_LIVE` → `LIVE_ATTESTED`, plus three `BLOCKED_*` states. |
| **Knowledge pack** | Researched, dated facts about a provider: deployments, SDK versions, trust profile, failure modes, limitations. |
| **Fail closed** | Every error path denies. There is no branch that can permit on a read failure. |

---

## License

MIT — see the `LICENSE` file in each package.

Kido: `Backend/Kido/LICENSE` · Amane: `Backend/Aname/LICENSE`
