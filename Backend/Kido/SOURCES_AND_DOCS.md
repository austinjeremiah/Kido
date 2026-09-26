# ContextLock Sources and Documentation

The full annotated bibliography is in `CONTEXTLOCK_BUILD_BIBLE.md` and the corresponding References chapter under `agent_docs/`. These are the primary sources agents must re-check before sponsor-integration phases.

## Official build sources

- ETHGlobal ETHOnline 2026 event details: https://ethglobal.com/events/ethonline2026/info/details
- ETHGlobal ETHOnline 2026 prizes: https://ethglobal.com/events/ethonline2026/prizes
- ENSv2 Enhanced Access Control: https://docs.ens.domains/ensv2/enhanced-access-control/
- ENSv2 Permissioned Registry: https://docs.ens.domains/ensv2/permissioned-registry/
- ENSv2 Registry Template: https://docs.ens.domains/ensv2/registry-template/
- ENSIP-26 Agent Text Records: https://docs.ens.domains/ensip/26/
- ENSv2 app developer guide: https://docs.ens.domains/ensv2/tutorial-app-developers/
- ENS deployments: https://docs.ens.domains/learn/deployments/
- Chainlink CRE: https://docs.chain.link/cre
- Chainlink Confidential Workflow template: https://docs.chain.link/cre-templates/hello-confidential-workflows
- Chainlink EVM Log Trigger: https://docs.chain.link/cre/guides/workflow/using-triggers/evm-log-trigger
- Chainlink on-chain write: https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/overview
- Chainlink liquidation protection template: https://docs.chain.link/cre-templates/automated-liquidation-protection
- Ledger ETHOnline 2026: https://developers.ledger.com/ethonline
- Ledger AI tools: https://developers.ledger.com/docs/ai-tools/overview
- Ledger Wallet CLI / Key Ring: https://developers.ledger.com/docs/ai-tools/ledger-cli
- Ledger DMK Skills: https://developers.ledger.com/docs/ai-tools/ledger-dmk-skills
- Ledger Ethereum Device Signer Kit: https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/how_to/how_to_use_a_signer
- Ledger Clear Signing: https://developers.ledger.com/docs/clear-signing/overview
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
- ERC-1271: https://eips.ethereum.org/EIPS/eip-1271
- ERC-4337: https://eips.ethereum.org/EIPS/eip-4337

## Security / research foundations

- Norm Hardy, The Confused Deputy: https://css.csail.mit.edu/6.858/2015/readings/confused-deputy.html
- Miller, Yee, Shapiro, Capability Myths Demolished: https://erights.org/talks/myths/index.html
- Birgisson et al., Macaroons: https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/
- Greshake et al., Indirect Prompt Injection: https://arxiv.org/abs/2302.12173
- Debenedetti et al., AgentDojo: https://arxiv.org/abs/2406.13352
- Narisetty et al., Adaptive Evaluation of Out-of-Band Defenses (2026 preprint): https://arxiv.org/abs/2606.26479
- Tran et al., Rethinking Agent Security as a Networking Problem (2026 preprint): https://arxiv.org/abs/2608.12172

## Drift rule

ENSv2 and Chainlink Confidential Workflows are beta/current-event technologies. Official docs win if their interfaces change. File a `FND-*-doc-drift-*` report before adapting architecture or code.
