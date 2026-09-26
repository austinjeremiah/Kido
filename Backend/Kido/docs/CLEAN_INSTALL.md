# Reproducible clean install (P9.3)

Verified on **2026-09-08** from a genuine `git clone` into an empty directory — not from the
working tree, and with **no `.env` present**. Every command below was executed in that order and
its real output is recorded.

Host used for verification: macOS (darwin 27.0.0), Node 22, npm 10, Foundry (solc 0.8.28),
bun 1.4.2, CRE CLI 1.32.0.

---

## 1. Clone and install

```bash
git clone <repo> ContextLock && cd ContextLock
npm install
```

```
added 166 packages, and audited 174 packages in 4s
found 0 vulnerabilities
```

`package-lock.json` is committed, so this resolves identically on any host.

## 2. Vendored Solidity dependency

`contracts/lib/` is **not** committed. Restore it:

```bash
cd contracts && forge install foundry-rs/forge-std --no-git && cd ..
```

```
Installed forge-std
```

## 3. Build

```bash
npm run build
```

Builds all five workspace packages and both apps. No output on success beyond the per-package
`tsc` banners.

## 4. Typecheck

```bash
npm run typecheck
```

Clean — **0 TypeScript errors** across all workspaces.

## 5. Test

```bash
npm test                       # TypeScript workspaces
cd contracts && forge test     # Solidity
```

From a clean clone **with no `.env`**, the network-dependent suites *skip* rather than fail, and
they report themselves as skipped:

| Suite | Result |
|---|---|
| `packages/protocol` | 20 passed |
| `packages/ledger` | 24 passed, 1 skipped *(hardware — BLK-002)* |
| `apps/broker` | 68 passed, 5 skipped *(live ENS — needs `SEPOLIA_RPC_URL`)* |
| `contracts` | 106 passed, 2 skipped *(ENS fork test — needs `SEPOLIA_RPC_URL`)* |

The five skipped broker tests are named explicitly in the runner output:

```
↓ test/ens-live.test.ts > LiveEnsIdentityProvider (Sepolia) > ID-001: resolves the live registered agent name
↓ ... the identity hash tracks live ENS state, so it changes when the name's token id changes
↓ ... ID-006: an unconfigured name fails closed with an OperationalError
↓ ... ID-006: an unreachable RPC fails closed rather than returning an identity
↓ ... never returns a cached identity: each resolve performs a fresh chain read
```

A skipped test reports **SKIPPED**, never PASSED. With a `.env` supplying `SEPOLIA_RPC_URL` these
seven skips become passes, giving the full **266 passing**.

## 6. The CRE workflow (separate toolchain)

The confidential workflow is a **bun** project outside the npm workspace, so `npm install` does not
reach it. On a clean clone it needs its own install:

```bash
cd workflows/cre-policy/contextlock-policy
bun install --frozen-lockfile     # bun.lock is committed
bun test
```

```
41 pass, 0 fail, 92 expect() calls
```

Without this step the suite fails with `Cannot find module '@chainlink/cre-sdk/test'`. That was
found by this very clean-install check; `scripts/test-all.sh` now bootstraps it automatically and
says so, rather than surfacing the opaque module error.

The symlink `contextlock-cre/policy/policy.ts → packages/policy/src/index.ts` survives a clean
clone intact (verified) — the policy function has exactly one implementation, and the CRE project
compiles the same file the broker imports.

## 7. One command for all of it

```bash
npm run test:all
```

Runs 12 steps and prints a summary. From the clean clone:

```
  PASS  typecheck
  PASS  contracts
  PASS  contracts fmt
  PASS  protocol
  PASS  adapters build
  PASS  ledger (non-hw)
  PASS  broker
  PASS  cre workflow
  PASS  secret scan
  PASS  canary scan
  PASS  privilege audit
  PASS  npm audit

  Ledger HARDWARE tests: NOT RUN (BLK-002) — see `npm run test:ledger:hardware`
ALL NON-HARDWARE SUITES PASS
```

> The first clean-install run of this command did **not** print that. It printed
> `FAIL canary scan` and `FAIL privilege audit`, and it was right to — see **FND-017** and
> **FND-018**. Both were scanner defects that had gone unnoticed because the suites had only ever
> been run in a working tree that predated the files they tripped on. This is the reason the clean
> install check exists.

## 8. Live-network extras (optional)

Only needed to run the demos against Sepolia. Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `SEPOLIA_RPC_URL` | all live reads and writes |
| `DEPLOYER_PRIVATE_KEY` | deploys and policy administration |
| `CAPABILITY_ISSUER_PRIVATE_KEY` | signs capabilities |
| `RELAYER_PRIVATE_KEY` | submits transactions |
| `CRE_ETH_PRIVATE_KEY` | the authorized CRE writer |
| `APPROVER_STANDIN_PRIVATE_KEY` | the STAND-IN human approver (a Ledger replaces this) |

Full descriptions in `ENV_REQUIRED.md`. Then:

```bash
npm run health          # read-only preflight; prints HEALTH: READY
npm run demo:all        # six live Sepolia scenes
npm run ui              # operator console on http://localhost:3000
```

Every deployment and demo script asserts `chainId == 11155111` before doing anything.

## 9. What a clean clone still cannot do

- **Ledger hardware tests** — `npm run test:ledger:hardware` fails loudly with BLK-002 until a
  physical device is attached. It does not skip and it does not mock.
- **A live CRE deployment** — the workflow is exercised in the official CRE CLI simulator
  (`cre workflow simulate`), which requires `cre login`. See `docs/CRE_MODE_BASELINE.md`.
