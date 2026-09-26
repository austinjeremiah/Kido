# Kido

**A foundry for bounded financial agents.** Describe what you want an agent to do; Kido interviews you until the requirements are unambiguous, compiles a canonical blueprint, selects providers from a registry by what they have actually proven, and builds agents whose every financial action is bounded on-chain by [Amane](https://github.com/Kaushikh76/Amane) on Ethereum and Sui.

> **Status:** testnet prototype (Ethereum Sepolia, Sui Testnet). **Not audited.** Backend only — exposed through an HTTP API and a CLI.

```
"Protect my Aave position using liquidity on Sui"
        │
        ▼
 design interview ──► blueprint (versioned, hashed) ──► security review + simulation ──► build
        │                                                                                  │
        │   asks only what matters: authority, limits, payees, privacy, recovery           ▼
        │                                                         Amane account per chain (owner-signed policy,
        ▼                                                         issuer-signed lease) + identity + privacy
 provider registry (status = what is proven, never configuration)          │
                                                                           ▼
                                  runtime: deterministic monitors → agents propose → Amane enforces on-chain
```

## What Kido does

- **Design interview** — asks in human terms (withdrawal? arbitrary recipients? how much autonomously? hidden from whom?), never invents authority, and treats the user's own words as authoritative over any model reading of them. Private values (e.g. a risk threshold) are never stored, logged or shown to a model.
- **Canonical blueprint** — the single source of truth: objective, chains, agents, monitors, authority, identity, privacy and recovery. Revisions are chained and confirmed requirements cannot be silently changed.
- **Provider registry** — ENS, SuiNS, Seal, Nautilus, Chainlink CRE, Aave, Uniswap, Cetus, Amane, Wormhole, LayerZero. Each record carries its implementation status (`NOT_IMPLEMENTED`, `IMPLEMENTED_LOCAL`, `SIMULATED`, `TESTNET_LIVE`, `BLOCKED_ENV`, `BLOCKED_AUTH`, `BLOCKED_UPSTREAM`) with what was proven, what was not, and the evidence. Selection only counts proven capabilities.
- **Authority through Amane** — Kido compiles the blueprint into an owner-signed root policy and a short-lived lease per chain endpoint. Kido never holds a root controller key; agents hold only a lease-scoped signing key, and the chain checks every action.
- **Runtime** — deterministic monitors (Aave health factor, allocation drift) wake agents; agents propose typed actions; the executor compiles them to Amane intents; recovery and cross-chain sagas run as explicit state machines.
- **Cross-chain** — a Wormhole transport where the destination Amane account is the reservation authority: arrivals are reserved on-chain for the one signed intent that sent them.
- **Identity** — one `KidoAgentId` bound through ENS and SuiNS; names are discovery, never authority.
- **Privacy** — requirements compile to providers by trust model: Seal for encrypted state with on-chain reader policies; Nautilus (local tier) or CRE for decisions over private inputs, disclosing only the decision.
- **Self-knowledge** — agents answer questions about their own authority, providers and limits from a self-model, and say "unknown" instead of guessing.

## Provider status (from the registry)

| Provider | Role | Implementation |
|---|---|---|
| Amane | financial authority (Ethereum + Sui) | `TESTNET_LIVE` |
| Aave v3 · Uniswap v3 · Cetus CLMM | repay · swap · swap | `TESTNET_LIVE` |
| Wormhole | cross-chain transport (Token Bridge) | `TESTNET_LIVE` |
| ENS | identity binding | `TESTNET_LIVE` |
| Seal | encrypted state with on-chain reader policy | `TESTNET_LIVE` |
| SuiNS | identity binding | reads live; registration `BLOCKED_ENV` (registrar payment) |
| Nautilus | private decisions in a TEE | `IMPLEMENTED_LOCAL` (no attested enclave host) |
| Chainlink CRE | private decisions | `SIMULATED` (`BLOCKED_AUTH`: interactive CRE login) |
| LayerZero | transport | `BLOCKED_UPSTREAM` (Sui SDK requires the retired JSON-RPC) |

`SIMULATED` is never presented as live, and `IMPLEMENTED_LOCAL` never as attested.

## Live testnet scenarios

All run against Sepolia and Sui testnet with disposable keys, and write evidence outside the repository.

| Script | Scenario |
|---|---|
| `scripts/e2e-ethereum-a.ts`, `e2e-ethereum-a-attacks.ts` | Aave health factor falls → agent repays a pinned beneficiary's debt through Amane; attack variants rejected on-chain |
| `scripts/e2e-sui.ts` | Sui trading agent: allocation drift → swap through the pinned Cetus pool; attack variants |
| `scripts/e2e-identity.ts`, `identity-live.ts` | one KidoAgentId bound through ENS; rotation and revocation; SuiNS reads |
| `scripts/seal-live.ts`, `seal-regression.ts` | Seal encryption, reader policy changes, cached-key regression |
| `scripts/cre-receiver-live.ts` | CRE receiver on Sepolia (simulated forwarder) |
| `scripts/e2e-crosschain-live.ts` | Kido's cross-chain engine drives a Sui → Sepolia → Sui round trip over Wormhole; both reservations enforced on-chain |
| `scripts/e2e-crosschain-rescue.ts` | Cross-chain position rescue: health factor below target → Cetus swap on Sui → Wormhole → reserved swap into Aave USDC → REPAY |

## Quick start

```bash
npm ci
npm run build
npm test

# CLI
npm run kido -- create "Build me a treasury agent on Ethereum that pays my supplier"
npm run kido -- next <project>
npm run kido -- answer <project> "only recipients I approve"
npm run kido -- finalize <project>
npm run kido -- security-review <project>
npm run kido -- simulate <project>
npm run kido -- build <project>
npm run kido -- ask <project> "What are you allowed to do?"

# HTTP API
npm run kido:api
```

| API | |
|---|---|
| `POST /projects` | start a project from an objective |
| `GET /projects/:id/next` · `POST /projects/:id/answer` · `POST /projects/:id/edit` · `GET /projects/:id/unresolved` | the interview |
| `GET /projects/:id/blueprint` · `POST /projects/:id/finalize` | blueprint revisions |
| `POST /projects/:id/security-review` · `POST /projects/:id/simulate` · `POST /projects/:id/build` · `GET /projects/:id/status` | gates and lifecycle |
| `POST /projects/:id/introspect` · `GET /projects/:id/self-model` · `GET /projects/:id/context/:role` | self-knowledge and exact agent context |
| `GET /registry` · `GET /registry/:id` · `GET /knowledge/drift` | providers and knowledge packs |

Configuration is environment-only; see [`ENV_REQUIRED.md`](ENV_REQUIRED.md). The API takes controller, issuer and agent **addresses** — never keys.

## Repository layout

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
move/                      kido_seal policy, kido_nautilus decision verifier
workflows/kido-cre         CRE decision workflow
knowledge/                 generated knowledge packs
scripts/                   live testnet scenarios, audits
```

## Checks

```bash
npm test                 # all workspaces
npm run typecheck
npm run privilege-audit  # model-facing agents cannot reach keys; only operator scripts read them
npm run canary-scan      # a private value never reaches the blueprint, the model, agent context or the repo
npm run secret-scan      # no secret material tracked
```

## Limitations

- Not audited; testnet assets only.
- Wormhole testnet has a single guardian; Sepolia-originated transfers wait for Ethereum finality (~15 min); VAAs are redeemed by Kido's relayer.
- Nautilus runs only as a local, unattested tier; CRE runs through a simulated forwarder; SuiNS registration is blocked on registrar payment.
- A cross-chain rescue is bounded by lease caps and may restore the health factor only partially.

## License

MIT — see [LICENSE](LICENSE).
