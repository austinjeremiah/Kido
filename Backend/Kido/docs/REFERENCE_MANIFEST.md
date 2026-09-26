# Reference Manifest

Every source the build depends on, with **verification status as of 2026-09-06**.
"Verified" means the page was fetched during this build and the claim we rely on was read from it
directly — not recalled from the specification.

## ETHGlobal

| # | Source | Status | What we rely on |
|---|---|---|---|
| 1 | [ETHOnline 2026 details](https://ethglobal.com/events/ethonline2026/info/details) | Verified | Deadline 13 Sep 2026 12:00 EDT; ≤3 partner prizes; 2-4 min video; version-control requirement; AI attribution |
| 2 | [ETHOnline 2026 prizes](https://ethglobal.com/events/ethonline2026/prizes) | Verified | ENS $4,500 / Chainlink $2,000 / Ledger $3,500 tracks and qualification text |

## ENS (Phase 3)

| # | Source | Status | What we rely on |
|---|---|---|---|
| 3 | [ENSv2 Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/) | Verified | Roles are defined **per contract**; uint256 role/admin bitmap; ROOT_RESOURCE |
| 4 | [ENSv2 Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/) | Verified | Exact role constants; mutable token IDs; expiry and `unregister()` semantics |
| 5 | [ENSv2 Registry Template](https://docs.ens.domains/ensv2/registry-template/) | Referenced | UserRegistry / subregistry extension points |
| 6 | [ENSIP-26 Agent Text Records](https://docs.ens.domains/ensip/26/) | Verified | Draft status; `agent-context`, `agent-endpoint[mcp|a2a|web]` |
| 7 | [ENSv2 App Developer Guide](https://docs.ens.domains/ensv2/tutorial-app-developers/) | Verified | Sepolia beta; MockUSDC registration fee; do-not-hardcode-resolver guidance |
| 8 | [ENS Deployments](https://docs.ens.domains/learn/deployments/) | Verified | Canonical Sepolia addresses; `ensdomains/ens-contracts` is source of truth |

## Chainlink (Phase 4 - not implemented in this run)

| # | Source | Status | What we rely on |
|---|---|---|---|
| 9 | [Chainlink CRE](https://docs.chain.link/cre) | Verified | Nav; deploy access + confidential access are separate gates |
| 10 | [Hello Confidential Workflows](https://docs.chain.link/cre-templates/hello-confidential-workflows) | Verified | `handlerInTee` / `getSecret` / `usingTheDons`; Nitro us-west-2; simulator/logging warnings |
| 11 | [EVM Log Trigger](https://docs.chain.link/cre/guides/workflow/using-triggers/evm-log-trigger) | Pending Phase 4 | Event-driven request flow |
| 12 | [Onchain Write](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/overview) | Pending Phase 4 | Report → consumer write path |
| 13 | [Automated Liquidation Protection](https://docs.chain.link/cre-templates/automated-liquidation-protection) | Verified (addresses probed) | Challenge contract; `join()` closed until 8 Sep |
| — | [CRE CLI login](https://docs.chain.link/cre/account/cli-login) | Verified | `cre login`; email+password+2FA; creds in `~/.cre/cre.yaml` |
| — | [Confidential Workflows access](https://docs.chain.link/cre/account/confidential-workflows-access) | Verified | Private beta, invite-only via form; simulator needs no approval |

## Ledger (Phase 6/7 - not implemented in this run)

| # | Source | Status | What we rely on |
|---|---|---|---|
| 14 | [Ledger ETHOnline 2026](https://developers.ledger.com/ethonline) | Verified | Scoped-capability broker pattern; human-in-the-loop; mandatory DX feedback |
| 15 | [Ledger AI Tools Overview](https://developers.ledger.com/docs/ai-tools/overview) | Pending Phase 6 | Agent patterns, hardware confirmation |
| 16 | [Ledger Wallet CLI](https://developers.ledger.com/docs/ai-tools/ledger-cli) | Verified | `ring init/encrypt/decrypt/keys/destroy`; device for init only; network dependency; `WALLET_PASS` |
| 17 | [Ledger DMK Skills](https://developers.ledger.com/docs/ai-tools/ledger-dmk-skills) | Pending Phase 7 | Coding-agent signing guidance |
| 18 | [Ethereum Signer Kit](https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/how_to/how_to_use_a_signer) | Pending Phase 7 | Device signing integration |
| 19 | [Clear Signing](https://developers.ledger.com/docs/clear-signing/overview) | Verified | ERC-7730 descriptor; published to open registry (local-load unconfirmed — Phase 7 risk) |

## Standards

| # | Source | Status | What we rely on |
|---|---|---|---|
| 20 | [EIP-712](https://eips.ethereum.org/EIPS/eip-712) | Applied | Typed data + domain separation. **Explicitly provides no replay protection** — ContextLock supplies nonce+expiry+live-state checks |
| 21 | [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) | Implemented | Contract-signature issuer path (CAP-012) |
| 22 | [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) | Future work | Not in MVP |

## Security research (design rationale)

| # | Source | Contribution |
|---|---|---|
| 23 | [Hardy — The Confused Deputy](https://css.csail.mit.edu/6.858/2015/readings/confused-deputy.html) | Why ambient authority is the bug |
| 24 | [Miller, Yee, Shapiro — Capability Myths Demolished](https://erights.org/talks/myths/index.html) | Least authority, revocation |
| 25 | [Birgisson et al. — Macaroons](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/) | Contextual caveats on credentials |
| 26 | [Greshake et al. — Indirect Prompt Injection](https://arxiv.org/abs/2302.12173) | The threat the demo agent embodies |
| 27 | [Debenedetti et al. — AgentDojo](https://arxiv.org/abs/2406.13352) | Adversarial tool-use benchmark framing |
| 28 | [Narisetty et al. — Out-of-Band Defenses (2026 preprint)](https://arxiv.org/abs/2606.26479) | Deterministic external enforcement; preprint, not consensus |
| 29 | [Tran et al. — Agent Security as Networking (2026 preprint)](https://arxiv.org/abs/2608.12172) | Capability/zero-trust framing; preprint |
