# The fork lab

Deploy a built agent to a local Anvil fork of Ethereum mainnet, activate it, and watch it act on
real protocol state — with the whole ContextLock path in the loop and nothing reaching a public
chain.

## Run it

```bash
set -a; source .env; set +a
STUDIO_CRE_SEPOLIA_RPC=https://1rpc.io/sepolia npm run studio:api   # http://127.0.0.1:4310
npm run frontend                                                    # http://localhost:3000 (apps/frontend)
```

`STUDIO_CRE_SEPOLIA_RPC` is only needed while the Alchemy Sepolia key in
`workflows/cre-policy/contextlock-cre/.env` is rate-limited: the official CRE simulation fetches
its trigger receipt through it. Needs `anvil` (Foundry), Docker for the build sandbox,
`contracts/out` (run `forge build` in `contracts/` if missing), and a reachable mainnet RPC
(`MAINNET_RPC_URL`, default publicnode).

Two forks may run at once by default (§P27.49 — each is an Anvil process and an upstream RPC bill
for every state slot it lazily fetches). A swarm deploys one fork per member, so raise it knowingly:
`STUDIO_MAX_FORKS=6 npm run studio:api`.

## The path

1. **Design and build** an agent from a prompt. The architect chooses actions from the protocol
   catalogue (`packages/studio-blueprint/src/templates/protocols.ts`): Aave v3, Morpho Blue,
   Compound v3, Lido, and a DEX router for swaps. An agent may use several.
2. **Deploy tab → Run official CRE simulation.** The real `cre workflow simulate`, recorded per run.
3. **Deploy tab → Local Mainnet Fork → DEPLOY.** Gates are re-checked server-side. The deployment:
   forks mainnet at an exact block and verifies the anchor; deploys the ContextLock core, the
   approval registry and the agent's consumer from `contracts/out`; registers the policy
   **DISABLED**; opens one position per protocol the Blueprint's actions call for (a *scenario
   driver*, `apps/studio/src/fork/drivers.ts`); seals a market snapshot from those reads; verifies
   by reading the fork back; starts the runtime. Ends at READY TO ACTIVATE.
4. **Activate.** `ENABLE_POLICY` through the P25 control plane, read back from the fork. The
   workspace moves to the deployed-agent console.
5. **Performance tab.** One tile per protocol, the health chart where a lending position exists,
   every decision with its reason code, every execution with its fork transactions. Stress
   controls per scenario are operator actions and are logged as such.

## What the agent does, and who decides

Every tick the runtime observes each position and each driver may propose one action, sized to
the Blueprint's per-action ceiling. The policy engine rules on it with the fork's own facts:

- **ALLOW** — a capability signed by the issuer role, an authorization recorded ALLOW, and
  `ContextLockExecutor.execute` submitted by the relayer role. The executor re-checks identity,
  policy, target, action, calldata hash, nonce, expiry and the authorization before it calls the
  protocol. Autonomous.
- **ESCALATE** — the same capability and an authorization recorded ESCALATE, then it waits. The
  console shows "Waiting for a human" with **Approve** and **Decline**. Approve signs the approval
  registry's EIP-712 digest with the deployment's *approver* key and records it; the executor
  consumes that approval when it runs the steps. The approver is a stand-in for the Ledger device,
  generated for the fork and labelled as such everywhere (BLK-002).
- **DENY** — recorded, and nothing can make it executable: the executor has no branch a DENY can
  reach, with or without an approval.

## Facts of the chain that shaped it

- The executor has no `receive()`. The vault (executor) holds tokens; the treasury's **native ETH**
  is held by the submitting account and travels as `cap.value`, which the executor forwards exactly.
  What Lido mints lands in the vault.
- Anvil's published dev accounts carry mainnet history (one has an EIP-7702 delegation that turns
  the executor's issuer check into an ERC-1271 call). Every role is a fresh key per deployment,
  funded on the fork by `anvil_setBalance`, held in memory only.
- Anvil block timestamps continue from the pinned block; every on-chain time field uses the fork's
  latest block, not the wall clock.
- A fork lives as long as the server process. Rows whose process died are reconciled to STOPPED on
  the next start.

## Protocol scenarios

| Driver | Opens | Agent action | Stress |
|---|---|---|---|
| `aave-repay` | 5 WETH supplied, USDC borrowed to HF 1.80 | `AAVE_REPAY` when HF < floor | borrow more to a target HF |
| `compound-repay` | 5 WETH to Comet, USDC withdrawn (borrowed) to HF 1.80 | `COMPOUND_REPAY` (supplyTo base) | borrow more |
| `morpho-repay` | 5 ETH → stETH → wstETH → collateral in the wstETH/USDC 86% market, USDC borrowed to HF 1.80 | `MORPHO_REPAY` | borrow more |
| `lido-stake` | 0.8 ETH arrives for the treasury | `LIDO_STAKE` of ETH above the 0.5 reserve | more ETH arrives |
| `uniswap-rebalance` | 1 WETH + its value in USDC in the vault | `TOKEN_SWAP` when the allocation drifts > 5% | USDC arrives |

An action kind the fork has no driver for is named on the Deploy screen (`BLK-V2-FORK-SCENARIO`
when there is none at all) rather than silently skipped.

## Tests

```bash
npx vitest run apps/studio/test/fork-lab.test.ts                      # fast: gates, readers, policy derivation, reconciliation
CONTEXTLOCK_FORK_E2E=1 npx vitest run apps/studio/test/fork-lab.test.ts -t FORK-E2E   # live: five protocols, escalation, approval, lock (~90s)
```
