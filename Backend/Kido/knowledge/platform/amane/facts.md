# Amane bounded authority

Amane is optional financial authority. When a blueprint selects it, every financial action is an agent-signed ActionIntent checked on-chain: Action ⊆ Lease ⊆ RootPolicy.

- The Root Policy (signed by the owner's controllers) sets per-chain limits in token base units, allowed actions and adapters, pinned payees and beneficiaries, owner price floors and recovery destinations.
- A lease gives one agent key a short-lived subset of that authority. The agent key can never sign a lease.
- Budgets are token buckets per chain: burst up to maxPerEpoch, refilling over the epoch; worst case 2x per window. Exposure across chains is the sum of per-chain limits.
- Relayers are untrusted: they cannot change a signed action, redirect output or take custody.
- Outcomes: EXECUTED (receipt), REJECTED_BY_AMANE {code} (a policy decision, not an error), NONCE_CONSUMED (settle from chain events; neither success nor retry), OPERATIONAL_FAILURE.
- Pause needs one controller; unpause needs the threshold and names the exact pause. Revoked or expired leases fail on-chain even if the agent keeps running.
- v1 ships PAY; SWAP and REPAY adapters are pending. Testnet prototype, not audited.
