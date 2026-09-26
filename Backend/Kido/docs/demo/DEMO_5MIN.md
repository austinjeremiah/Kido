# 5-minute extended demo script

**Target: 4:50.** For a technical audience that will ask how it works. Everything live on Sepolia.

Preflight: `npm run health` → **HEALTH: READY**. Console at `localhost:3000`. Terminal font large
enough to read the revert reasons — the revert reasons are the evidence.

---

## 0:00 — 0:35 · The confused deputy, named

> "Every AI-agent-with-a-wallet design has the same shape, and it's a classic security bug: the
> **confused deputy**. You give a component authority, someone else supplies its instructions, and
> it uses your authority for their purpose.
>
> Prompt injection is that bug with a new delivery mechanism. The instruction arrives inside the
> data the agent was asked to read.
>
> The usual mitigations are a spending cap and a better system prompt. The cap answers *how much*
> and nothing else. The system prompt asks the component under attack to defend itself.
>
> ContextLock takes the key away. The agent gets a **capability**: a signed assertion authorizing
> exactly one transaction, for a short window, revocable, re-checked on-chain by something the
> agent cannot influence."

## 0:35 — 1:05 · The architecture, in one pass

*Console → Architecture tab.*

> "The agent proposes an intent. It holds no key and it never submits a transaction.
>
> Three independent authorities answer three different questions. **ENS**: who is this agent, and
> is that still true? **A Chainlink confidential workflow**: is this safe right now, under private
> thresholds? **Ledger**: holds secrets the agent can't reach, and gates the high-risk path behind
> a human.
>
> Three verdicts, not two: ALLOW, ESCALATE, DENY. Then an EIP-712 capability — one transaction, one
> nonce, short expiry — and the executor, which is a **reference monitor**: nine ordered validation
> groups before any external call, and it re-checks every one of those three answers itself. It
> trusts nothing it was handed."

## 1:05 — 1:35 · ALLOW

```bash
npm run demo:allow
```

> "Routine rebalance, five hundred USDC. Identity resolves live. CRE returns ALLOW. Capability
> minted, thirty-minute expiry. Executed.
>
> No human. That's deliberate — a firewall that blocks everything gets turned off."

## 1:35 — 2:20 · DENY, and what the agent never had

```bash
npm run demo:deny
```

> "The agent has been fed an injected instruction. Fifty thousand USDC to a dead address.
>
> Watch the agent **comply**. It's supposed to — we assume it's compromised. It builds the request
> the attacker asked for.
>
> Stopped at CRE. `DENY_AMOUNT_TOO_HIGH`, against a threshold that lives in the confidential
> workflow and never touches the chain. `callCount` unchanged. Attacker balance zero.
>
> And DENY here is **terminal**. It's not 'escalate with more friction'. There's no path from DENY
> to execution — I'll show you that in a moment."

## 2:20 — 3:00 · Binding: mutation and replay

```bash
npm run demo:mutate
npm run demo:replay
```

> "Two attacks on the capability itself.
>
> First: a valid capability is issued, then the attacker swaps the recipient **and** the amount
> before submitting. `CalldataHashMismatch`. All fifteen fields are signed; the calldata is bound by
> hash. We fuzz all fifteen — five hundred and twelve runs.
>
> Second: replay the exact successful transaction. `NonceUsed`. EIP-712 gives you **no** replay
> protection by itself — that's a common misreading. The nonce and the expiry and the live-state
> checks are what supply it."

## 3:00 — 3:35 · Confidentiality, falsifiable

```bash
npm run demo:cre-private-context
```

> "The strongest evidence in the project.
>
> One Sepolia transaction — this hash, unchanged across all four scenes. Same amount, agent,
> target, policy id, policy version. The **only** difference is confidential market context inside
> the handler.
>
> Benign: ALLOW. Volatile: ESCALATE. High slippage: DENY. Illiquid: DENY.
>
> Nothing an observer can see changed, and the verdict changed four times. So the decision depends
> on data only the confidential handler reads — and the chain gets a coarse reason code, never a
> threshold. Anyone can run this and try to break it."

## 3:35 — 4:10 · Revocation and the human boundary

```bash
npm run demo:ens-revoke
npm run demo:escalate:software
```

> "Revocation first. This capability is signed and **unexpired**. I revoke the agent's ENSv2 role;
> the token id regenerates; the identity hash no longer matches. `IdentityNotCurrent`. Authority
> that was already granted is gone. A cap cannot do that.
>
> Then escalation. Five thousand USDC, above the private autonomous limit. Verdict ESCALATE. First
> attempt without approval: `HumanApprovalRequired`. Approval recorded — and I'll flag it, this is
> a **stand-in key, not a Ledger device** — then, and only then, it executes.
>
> The one to keep: on Sepolia we recorded a **genuine, valid approval for a DENIED capability**.
> Execution was still refused. The approval was never even read. Human approval escalates autonomy;
> it cannot override policy."

## 4:10 — 4:35 · What the agent structurally cannot reach

*Console → Agents tab, deny-list on screen.*

> "Nine questions. Can the agent get the issuer key, the Ledger secret, bypass ENS, bypass CRE,
> mutate, replay, forge an authorization, self-approve, or override DENY.
>
> No to all nine — but six of them aren't *refused*. They're **inexpressible**. There's no request
> the agent can construct that reaches the question. The secret broker has no `getSecret` at all,
> only `performProtectedAction`. You can't trick an interface into leaking something it has no verb
> for.
>
> That's enforced by a privilege audit in CI, and the audit is proven able to fail — we plant a
> canary and confirm it fires before we accept a pass."

## 4:35 — 4:50 · Limits, then close

> "What's real: **ENS is live on Sepolia** and load-bearing. **Chainlink ran in the official CRE
> simulator** on real Sepolia event triggers — not a live DON, and nothing ran in a real TEE.
> **Ledger software is complete and tested, but no device was available**, so there's no hardware
> evidence and we don't claim that prize.
>
> Not audited. Testnet only, asserted in code.
>
> Two hundred sixty-six tests. Eighteen findings recorded, including four accepted risks and two we
> can't close. Nothing was closed to make the status look better.
>
> ContextLock. Authority, not keys."

---

## Anticipated questions

**"Isn't the capability issuer just another key?"**
Yes, and it's stated as a hot key in the threat model. The difference is blast radius: it can only
issue capabilities that survive the executor's nine validation groups, which re-check ENS identity,
the CRE verdict, the nonce, the expiry and the calldata hash on-chain. It cannot mint authority the
policy doesn't already permit.

**"What if the CRE workflow is wrong?"**
Then the verdict is wrong, and the executor faithfully enforces a wrong verdict. ContextLock
validates **permission**, not economic wisdom. That is a stated limitation, not a defect.

**"Why not just use a multisig?"**
A multisig puts a human on every transaction. This keeps routine work autonomous and puts the human
only on the escalation path — which is the whole reason there are three verdicts instead of two.

**"You said the simulator isn't a TEE — so what did you actually prove?"**
That the workflow logic is correct, that it decodes real Sepolia event data correctly, and that its
verdict depends on secrets it never emits. What is *not* proven is enclave attestation. Both halves
are in `docs/CRE_MODE_BASELINE.md`, which every other document defers to.

**"Can I see something fail?"**
Yes — plant a canary in any tracked file and run `npm run canary-scan`, or add a `process.env` read
to `apps/web` and run `npm run privilege-audit`. Both scanners are verified in both directions, and
both caught a real defect in this project on their first clean-clone run.
