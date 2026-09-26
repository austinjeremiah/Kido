# ContextLock Studio V2 Build Package

Use `CONTEXTLOCK_STUDIO_V2_BUILD_BIBLE.md` as the machine-readable source of truth for coding agents.
Use `ContextLock_Studio_V2_Build_Bible.pdf` for human review.

## Baseline

- Existing ContextLock runtime P0-P10 remains authoritative.
- Physical Ledger hardware validation remains an inherited release blocker until a real device is available.
- P11 is the Studio/Agent Foundry core.
- P12-P24 complete the adapter platform, protocol/data integrations, hosted runtime and production release path.

## New V2 phase order

1. P11 Studio Core
2. P12 Adapter Kernel & Registry
3. P13 Uniswap Execution Adapter
4. P14 The Graph Data Adapter Suite
5. P15 Chainlink Data / Context Adapter Suite
6. P16 Aave Generalized Adapter
7. P17 Strategy & Adapter Composition Compiler
8. P18 Multi-Agent Organization Builder
9. P19 Cross-Chain / Multi-Step Execution Plans
10. P20 Custom Adapter SDK + OpenAPI/API Importer
11. P21 Hosted Runtime + Local Credential Bridge
12. P22 Teams, Quotas, Billing & Observability
13. P23 Mainnet Security & Release Gates
14. P24 GA + Adapter Marketplace

## V2 core rule

Architecture, simulation and code are projections of one versioned `ContextLockAgentBlueprint`. Provider APIs and LLM outputs never become financial authority by themselves.
