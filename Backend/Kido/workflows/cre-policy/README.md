# Chainlink CRE Confidential Policy Workflow — PHASE 4, NOT IMPLEMENTED

Architecture placeholder only. This directory contains **no workflow code** and the project makes
**no Chainlink claim** at this point in the build.

When Phase 4 begins it will implement, per verified current docs:

- an EVM Log Trigger on `ContextLockGateway.CapabilityRequested`
- `cre.handlerInTee(trigger, fn, tees)` with `[{ tee: 'nitro', regions: ['us-west-2'] }]`
- `runtime.getSecret({ id })` for at least one private policy parameter, inside the enclave
- `runtime.usingTheDons()` carrying only non-sensitive verdict/commitment fields out
- the documented on-chain write path into `ContextLockAuthorizationRegistry`

Constraints already recorded from official docs (`docs/VERSIONS.md`):
the simulator is **not** a real TEE and must never receive real secrets; **do not log inside the
enclave** — logs leave the confidentiality boundary.

Access status: see `reports/phase-00/findings/FND-001`.
