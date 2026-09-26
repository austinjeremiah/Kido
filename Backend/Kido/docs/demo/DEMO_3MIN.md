# 3-minute demo script

**Target: 2:55.** Live Sepolia throughout. Nothing pre-recorded, nothing mocked.

Preflight before rolling: `npm run health` must print **HEALTH: READY**, and the relayer must hold
Sepolia ETH. Have `npm run ui` already serving on `localhost:3000` in a second window.

---

## 0:00 — 0:25 · The problem, stated once

> "To let an AI agent manage a treasury, you give it a key. A key is ambient authority — whoever
> holds it can do anything it can do.
>
> A spending cap answers one question: *how much*. It doesn't answer *which agent*, *to whom*,
> *through what contract*, *under what market conditions*, or *is that still true right now*.
>
> And prompt injection means the agent's instructions arrive inside the data it reads. Asking the
> model to refuse isn't a boundary. The model is the thing under attack.
>
> ContextLock gives the agent **authority instead of keys**. It assumes the agent is already
> compromised."

*On screen: the architecture tab of the console. Do not narrate the diagram.*

## 0:25 — 0:50 · The good path

```bash
npm run demo:allow
```

> "Five hundred USDC rebalance. ENS says who the agent is. A Chainlink confidential workflow says
> whether it's safe right now. The verdict is ALLOW, so it executes — **no human involved**.
>
> The point of a firewall isn't to block everything. Routine work stays autonomous."

*Point at the stage trace: `IDENTITY → CRE → CAPABILITY → EXECUTION`, and the Sepolia tx hash.*

## 0:50 — 1:25 · The attack

```bash
npm run demo:deny
```

> "Now the agent is compromised. Injected instruction: fifty thousand USDC to the attacker.
>
> The agent **complies** — that's the honest part. It asks for exactly what the attacker wanted.
>
> DENY. Stopped at the Chainlink verdict. Attacker balance: zero. And notice what the agent never
> had: it never held a key, so there was nothing for the injection to steal."

*Point at `STOP CRE — DENY (DENY_AMOUNT_TOO_HIGH)` and `callCount 18 → 18`.*

## 1:25 — 1:55 · Confidentiality you can falsify

```bash
npm run demo:cre-private-context
```

> "Same transaction. Same amount, same agent, same target, same policy version. The only thing
> changing is confidential market data inside the workflow.
>
> ALLOW. ESCALATE. DENY on slippage. DENY on liquidity.
>
> Nothing publicly observable changed — the verdict did. So the decision genuinely depends on data
> only the confidential handler can see. That's checkable, not a claim you have to take from me."

*Four verdict lines on screen at once. This is the beat to let land.*

## 1:55 — 2:25 · Revocation, and the terminal DENY

```bash
npm run demo:ens-revoke
```

> "This capability is correctly signed and **not expired**. I revoke the agent's ENS role — the
> token id regenerates, so the identity hash changes — and the capability dies mid-flight.
> `IdentityNotCurrent`. That's what a spending cap can't do."

Then, without running it, put the Phase 7 result on screen:

> "And the boundary in the other direction: we recorded a **genuine, valid human approval for a
> DENIED transaction** on Sepolia. Still refused. The approval wasn't even read — that branch is
> unreachable from DENY. Human approval escalates autonomy. It cannot override policy."

## 2:25 — 2:45 · What is and isn't real

> "Being precise, because this matters more than the demo:
>
> **ENS is live** on Sepolia and load-bearing.
> **Chainlink ran in the official CRE simulator**, triggered by real Sepolia events — *not* a live
> DON, and nothing ran in a real TEE.
> **Ledger integration is complete and tested, but no physical device was available** — so there's
> no hardware evidence, and we're not claiming that prize.
>
> All of that is in the README's first table, not its last section."

## 2:45 — 2:55 · Close

> "Two hundred sixty-six tests. Eighteen findings recorded, including the ones we couldn't close.
> Six of the nine attacks aren't refused — they're **inexpressible**. There's no request the agent
> can construct that reaches the question.
>
> ContextLock. Authority, not keys."

---

## Rules for this script

- **Never** say "runs in a TEE", "deployed to CRE", or "Ledger-approved". They are false.
- If a live transaction is slow, keep talking — do not cut and do not switch to a recording.
- If a scene genuinely fails, say so on camera and move on. A demo that admits a failure is worth
  more than one that hides it, and a judge who catches the hiding discounts everything else.
