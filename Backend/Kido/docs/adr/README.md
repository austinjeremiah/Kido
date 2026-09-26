# Architecture Decision Records

Nine decisions that shaped ContextLock. Each records what was decided, why, and what was rejected —
the rejected alternatives are usually the more useful half.

| ADR | Decision | Phase |
|---|---|---|
| [001](ADR-001-escalate-requires-human-approval.md) | The executor consults an approval registry on ESCALATE | 7 |
| [002](ADR-002-ens-identity-not-financial-permissions.md) | ENS carries identity and revocation, not spend authority | 3 |
| [003](ADR-003-cre-authorization-writer.md) | The authorization writer is a restricted contract, not an EOA | 4 |
| [004](ADR-004-eip712-capability-structure.md) | Capability structure, and the intent/calldata split | 1 |
| [005](ADR-005-execution-time-revocation.md) | Revocation is checked at execution, not at issuance | 3 |
| [006](ADR-006-allow-escalate-deny.md) | Three verdicts, and DENY is terminal | 4 |
| [007](ADR-007-keyring-vs-human-signing.md) | Key Ring and device signing stay separate | 6/7 |
| [008](ADR-008-simulator-vs-live-classification.md) | "Simulator" and "live" are different words | 4 |

## The two that matter most for review

**ADR-002** explains why ContextLock does *not* encode spend permissions in ENS, even though that
looks like the obvious integration. ENSv2 EAC roles are per-contract and the stock registry's ten
roles are all name administration — none means "may spend". Inventing one would produce a
permission that looks enforced and is not.

**ADR-006** explains why DENY is structurally terminal rather than terminal by convention, and
records the live Sepolia proof: a genuine, valid human approval for a DENIED capability, and
execution still refused.

## Decisions recorded elsewhere

Some choices are documented as findings, because they were forced by discovering something rather
than by weighing options:

- **FND-008** — three live ENSv2 Sepolia deployments exist and disagree; how the right one was
  identified.
- **FND-009** — a name registered through `ETHRegistrar` does not grant its owner `ROLE_UNREGISTER`,
  which invalidated an assumed revocation mechanism and surfaced a better one.
- **FND-012** — the EVM log trigger delivers a raw protobuf `Log`, not a decoded struct.
