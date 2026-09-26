# Kido Agent Blueprint

The blueprint (schema kido.agent-blueprint/v2) is the single source of truth for an agent: objective, requirement resolutions (USER_REQUIRED / SAFE_DEFAULT / INFERABLE with provenance), chains, identity plan, protocols, assets, data sources, privacy plan, authority (mode, provider, limits, payees, beneficiaries, bridge decision, lease lifetime), monitors, agents, recovery, optional cross-chain policy and optional Amane binding.

- Every artifact (simulation, build, security report, runtime) is bound to a blueprint revision and hash; a mismatch means it is stale.
- Confirmed user answers cannot be changed by a model; only an explicit user edit creates a new revision.
- Authority modes: NONE, READ_ONLY, PROPOSE_ONLY, APPROVAL_REQUIRED, BOUNDED_AUTONOMOUS_FINANCE (only the last uses Amane).
