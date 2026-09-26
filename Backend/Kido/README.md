# ContextLock

**A capability firewall for autonomous finance.** Give AI agents *authority*, not keys.

> The agent can be compromised without the wallet being compromised.

ContextLock assumes the agent is hostile. It does not ask the model to police itself: a
deterministic on-chain reference monitor decides whether **one exact transaction** is authorized
under current identity, policy, market context, nonce and time constraints.

---

## Status, stated precisely

| | Status |
|---|---|
| **ENSv2** | **LIVE on Sepolia** — identity and revocation are load-bearing |
| **Chainlink CRE** | **Official CLI simulator**, triggered by real Sepolia events. *Not* a live DON. *Nothing ran in a real TEE.* |
| **Ledger** | **Software complete and tested. No physical device was available** — no Key Ring provisioned, no hardware approval, no on-device Clear Signing (BLK-002) |
| Audited | **No** |
| Network | Sepolia testnet only; every deploy script asserts `chainId == 11155111` |

Nothing in this repository claims a TEE execution, a live CRE deployment, or a hardware approval
that did not happen. See [`docs/CRE_MODE_BASELINE.md`](docs/CRE_MODE_BASELINE.md) and
[`reports/phase-06/blockers/BLK-002-no-physical-ledger-device.md`](reports/phase-06/blockers/BLK-002-no-physical-ledger-device.md).

---

## The problem

An AI agent managing a treasury needs a key, and a key is *ambient authority*: whoever holds it can
do anything it can do. Wallet spending caps answer one question — **how much** — and none of the
others:

- **which** agent is this, and is that still true?
- **to whom**, through **what contract**?
- under **what market conditions**?
- is the approval that authorized this **still valid right now**?

Prompt injection makes this urgent. The agent's instructions arrive inside the data it reads, and
that data is attacker-controlled. Asking the model to refuse is not a boundary — the model is the
thing under attack.

## The approach

Replace the key with a **capability**: a signed assertion authorizing exactly one transaction, for
a short window, revocable, and re-checked on-chain by a component the agent cannot influence.

```
UNTRUSTED AGENT ──▶ BROKER ──┬──▶ ENSv2        who is this agent
   holds no key              ├──▶ CHAINLINK    is this safe right now (private policy)
   may be compromised        └──▶ LEDGER       secrets + human gate
                                     │
                        ALLOW ── ESCALATE ── DENY
                          │         │          │
                    autonomous   human      terminal
                          │      approval   (no path)
                          └────────┬─────────┘
                                   ▼
                        EIP-712 CAPABILITY  ── one tx, one nonce, short expiry
                                   ▼
                        CONTEXTLOCK EXECUTOR ── re-checks everything, fails closed
                                   ▼
                             EXACT ACTION
```

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Threat model in one line

Hostile: the agent, the relayer, target contracts, the RPC, all API input.
Assumed honest: the capability-issuer key (hot, bounded blast radius), the policy admin, chain
consensus. Full model and known limitations: [`SECURITY.md`](SECURITY.md).

---

## Where each integration lives

| Sponsor | Code | Evidence |
|---|---|---|
| **ENSv2** | [`EnsAgentIdentityVerifier.sol`](contracts/src/identity/EnsAgentIdentityVerifier.sol) · [`ens-live.ts`](apps/broker/src/providers/ens-live.ts) · [`packages/ens/`](packages/ens/) | [phase-03](reports/phase-03/) |
| **Chainlink CRE** | [`workflow.ts`](workflows/cre-policy/contextlock-policy/workflow.ts) · [`packages/policy/`](packages/policy/) · [`ContextLockCreConsumer.sol`](contracts/src/ContextLockCreConsumer.sol) | [phase-04](reports/phase-04/) |
| **Ledger** | [`key-ring.ts`](packages/ledger/src/key-ring.ts) · [`clear-signing.ts`](packages/ledger/src/clear-signing.ts) · [`ContextLockApprovalRegistry.sol`](contracts/src/ContextLockApprovalRegistry.sol) | [phase-06](reports/phase-06/) · [phase-07](reports/phase-07/) |

## ALLOW / ESCALATE / DENY

Binary authorization forces every threshold to be a cliff — either the autonomous limit is uselessly
low, or a compromised agent gets a large budget. Three verdicts let the autonomous limit stay low
while larger actions remain *possible* with a human accepting the specific risk.

**DENY is structurally terminal.** Not "ESCALATE with more friction". Proven live on Sepolia: a
genuine, valid human approval was recorded for a DENIED capability and execution was **still
refused** — the approval was not even read, because the branch is unreachable from DENY.

## Deployed on Sepolia

Full manifest: [`deployments/sepolia.json`](deployments/sepolia.json)

| Contract | Address |
|---|---|
| **ContextLockExecutor (canonical, v2)** | `0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23` |
| ContextLockApprovalRegistry | `0xD6E420734667382e49091072e9824902d6c93574` |
| ContextLockCreConsumer | `0x0eAA86cDA5622A8384c3eC9F47aD129902A8123F` |
| ContextLockGateway | `0xA2cD6003b092a4F4a69b86e75b60dcDD7737d9Bb` |
| ContextLockPolicyRegistry | `0xCBd976E8BBbA70867d581A35e5a5CF1C2ed47F24` |
| ContextLockAuthorizationRegistry | `0xFAD71bbcCfFdFbFA8B500bc9b8FF6F0C7F9De8e3` |
| EnsAgentIdentityVerifier | `0xbD44B9A7491A3168F772Ca96433c17a0B18a6149` |
| MockTreasuryTarget | `0xf20B833b26b981F8A2211473f46cf457430CE153` |

**Agent ENS identity:** `contextlock-20260906-a83dc9.eth`

---

## Install

```bash
git clone <repo> && cd ContextLock
npm install
cd contracts && forge install foundry-rs/forge-std --no-git && cd ..
cp .env.example .env          # fill in SEPOLIA_RPC_URL and disposable testnet keys
```

Optional, for the Chainlink and Ledger paths:

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash   # CRE CLI v1.32.0
curl -fsSL https://bun.sh/install | bash                 # required for CRE TypeScript workflows
npm i -g @ledgerhq/wallet-cli                            # NOTE: the scope matters — see FND-011
```

> `npx wallet-cli` installs an **unrelated third-party package** whose surface includes
> `import <privateKey>`. Always use the scoped `@ledgerhq/wallet-cli`.

## Test

```bash
npm run test:all                # every non-hardware suite + secret, canary, privilege, npm audit
npm run test:ledger:hardware    # fails with BLK-002 until a device is attached
```

**266 tests · 0 failures · 1 skipped** (the skip is hardware-gated and reports SKIPPED, not PASSED).

## Demo

```bash
npm run health                    # read-only Sepolia preflight
npm run demo:all                  # six live scenes — five are attacks
npm run ui                        # operator console at http://localhost:3000
```

Individual scenes:

```bash
npm run demo:allow                # autonomous $500 rebalance, no human
npm run demo:deny                 # prompt injection → DENY, attacker gets nothing
npm run demo:mutate               # capability mutation → CalldataHashMismatch
npm run demo:replay               # replay → NonceUsed
npm run demo:ens-revoke           # ENS revocation kills an unexpired capability
npm run demo:escalate:software    # ESCALATE → approval required → executes
npm run demo:cre-private-context  # same tx, different private context, different verdict
```

### The single most interesting result

```
npm run demo:cre-private-context
```

One Sepolia transaction. Same amount, same agent, same target, same policy version. **Only the
confidential market context changes:**

| Private context | Verdict |
|---|---|
| benign | `ALLOW:ALLOW_POLICY_MATCH:LOW` |
| volatility 5000bps | `ESCALATE:ESCALATE_RISK:HIGH` |
| slippage 900bps | `DENY:DENY_SLIPPAGE:HIGH` |
| liquidity floor breached | `DENY:DENY_LIQUIDITY:HIGH` |

Nothing an observer can see in the transaction changed. The verdict did. The decision therefore
depends on data only the confidential handler reads.

### Studio: build an agent from a prompt, run it on a mainnet fork

```bash
npm run studio:api                # http://127.0.0.1:4310 — needs Docker, anvil, OPENAI_API_KEY
npm run frontend                  # http://localhost:3000 — the ContextLock workbench (apps/frontend)
```

Type what the agent should do; the studio designs it from a protocol catalogue (Aave v3, Morpho
Blue, Compound v3, Lido, a DEX router), reviews it, builds and tests it in a network-free sandbox,
runs the official CRE simulation, then deploys it to a local Anvil fork of mainnet where it acts on
real protocol state under the full ContextLock path — ALLOW executes on its own, ESCALATE waits for
a signature, DENY has no path. One prompt that exercises all five:

> Guard my treasury across Aave, Morpho Blue and Compound: keep every health factor above 1.6 and
> repay up to $1,000 automatically. Stake idle ETH above a 0.5 ETH reserve into Lido. Keep the vault
> 50/50 WETH–USDC and rebalance on the DEX when it drifts more than 5%. Anything from $1,000 to
> $5,000 needs Ledger. Never withdraw collateral.

An organization prompt ("a treasury department with a guardian per lending protocol, a staker and a
rebalancer") designs a swarm under one ENS root and builds each member the same way. Details:
[`docs/studio/FORK_LAB.md`](docs/studio/FORK_LAB.md) · [`reports/phase-11/DEMO.md`](reports/phase-11/DEMO.md).

---

## Security properties

| Question | Answer | Proof |
|---|---|---|
| Can the AI obtain the issuer key? | **No** | no endpoint returns it; the agent package cannot import a signer |
| Can the AI obtain the Ledger secret? | **No** | there is no `getSecret` — only `performProtectedAction` |
| Can the AI bypass ENS? | **No** | identity read live at execution, never cached |
| Can the AI bypass CRE? | **No** | verdict read on-chain, bound to a recomputed request hash |
| Can the AI mutate a capability? | **No** | 512-run fuzz across all 15 signed fields |
| Can the AI replay a capability? | **No** | on-chain nonce + independent `approvedUntil` |
| Can the AI forge an authorization? | **No** | `NotAuthorizer` / `NotForwarder`, live |
| Can the AI self-approve an escalation? | **No** | `onlyExecutor` consumption |
| Can human approval override DENY? | **No** | branch unreachable from DENY; proven live |

Six of these are **inexpressible** rather than merely refused — there is no request the agent can
construct that reaches the question.

## Known limitations

Full list: [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md). The ones that should change
your reading of everything above:

- **Not audited.** ENSv2 and CRE Confidential Workflows are both beta.
- **CRE is CLI simulation**, not a live DON and not a real enclave.
- **No Ledger hardware evidence** — BLK-002.
- The capability issuer is a **hot key**; compromise is bounded but real.
- No emergency pause or issuer rotation on the executor.
- A nonce is consumed **on success, not on attempt** (FND-005).
- ContextLock validates *permission*, not economic wisdom.

Every finding — including accepted risks and two open blockers — is in [`reports/`](reports/).
Nothing was closed to make the status look better.

## Sponsor qualification

Detailed mapping with transaction hashes: [`docs/PRIZE_QUALIFICATION.md`](docs/PRIZE_QUALIFICATION.md).

- **ENS** — live ENSv2 Sepolia name, execution-time verification, revocation demonstrably
  invalidating outstanding authority.
- **Chainlink** — a genuine `handlerInTee` confidential workflow whose private parameters change
  the verdict, evidenced via the **official CLI simulator**. Live deployment is *not* claimed.
- **Ledger** — integration software complete and tested; **physical hardware validation pending
  BLK-002**. Prize qualification is *not* claimed until device evidence exists.

## AI usage

Built with Claude Code against a human-authored specification, phase-gated with recorded evidence.
Full disclosure: [`AI_USAGE.md`](AI_USAGE.md).

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how the pieces fit |
| [`SECURITY.md`](SECURITY.md) · [`docs/THREAT_SURFACE.md`](docs/THREAT_SURFACE.md) | threat model, 20 surfaces |
| [`docs/PRIZE_QUALIFICATION.md`](docs/PRIZE_QUALIFICATION.md) | per-sponsor claims and evidence |
| [`docs/EVIDENCE_INDEX.md`](docs/EVIDENCE_INDEX.md) | every claim → the file or tx that supports it |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) | complete and unflattering |
| [`docs/CLEAN_INSTALL.md`](docs/CLEAN_INSTALL.md) | verified clean-clone sequence |
| [`docs/CRE_MODE_BASELINE.md`](docs/CRE_MODE_BASELINE.md) | **authoritative** CRE execution status |
| [`docs/CONTRACT_VERIFICATION.md`](docs/CONTRACT_VERIFICATION.md) | verify the bytecode yourself |
| [`docs/studio/FORK_LAB.md`](docs/studio/FORK_LAB.md) | the studio's mainnet-fork lab: five protocols, escalation, approval |
| [`docs/BUILD_STORY.md`](docs/BUILD_STORY.md) | what was hard and what went wrong |
| [`docs/adr/`](docs/adr/) | 8 architecture decision records |
| [`AI_USAGE.md`](AI_USAGE.md) · [`docs/SOURCE_PROVENANCE.md`](docs/SOURCE_PROVENANCE.md) | attribution |

## Repository map

```
contracts/        Solidity — executor, registries, ENS verifier, approval registry
packages/
  protocol/       capability schema + EIP-712 (independent of Solidity, cross-verified)
  policy/         the ALLOW/ESCALATE/DENY function — ONE implementation, two execution sites
  adapters/       typed transaction builders (no generic-call adapter, deliberately)
  studio-adapters/ Aave v3, Morpho Blue, Compound v3, Lido, Uniswap — the protocols the studio can build for
  ens/            ENSv2 deployment discovery
  ledger/         Key Ring, protected-service boundary, ERC-7730
apps/
  broker/         Fastify API, state machine, providers
  demo-agent/     intentionally untrusted agent + hostile prompt corpus
  frontend/       the ContextLock workbench (Next.js) — the product UI, wired to the studio API
  studio/         agent studio API — design, sandbox build, CRE simulation, mainnet-fork lab
  web/            LEGACY operator console (test-only; superseded by apps/frontend)
  studio-web/     LEGACY studio UI (test-only; superseded by apps/frontend)
workflows/
  cre-policy/     the confidential workflow + official CRE project
reports/          per-phase gate evidence, findings, blockers
docs/             architecture, threat surface, ADRs, prize mapping
```

## License

MIT — see [`LICENSE`](LICENSE).
