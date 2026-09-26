# Security

Kido is a **testnet prototype**. It has **not been audited**. Do not use it with real funds.

## The claim

A Kido agent can be wrong, prompt-injected or fully compromised without its owner's funds being
at risk beyond the authority the owner granted. Kido does not prevent prompt injection; it bounds
what an injected agent can do, and that bound is enforced on-chain by Amane, not by Kido.

## Trust boundaries

- **Model-facing agents** (`@kido/agents`) are untrusted. They hold no key, read no secret, and can
  only propose typed actions. `npm run privilege-audit` checks this from source and dependencies.
- **Kido backend** is not a root of authority. It compiles policies and leases for the owner to sign
  and relays actions; it never holds a root controller key. A compromised backend can stop acting,
  but cannot widen what the owner signed.
- **Amane accounts** (Ethereum and Sui) are the authority boundary: every action is checked against
  the lease and the owner's policy before value moves, and results are measured.
- **Transports** (Wormhole) are not authority: a delivery is re-verified by the destination account
  against the signed source intent and the destination it committed to.
- **Private inputs** (e.g. a risk threshold) never enter Kido state, logs or model context;
  `npm run canary-scan` checks every surface with a fresh canary per run.

## Known limitations

| Limitation | Status |
|---|---|
| Not audited | acknowledged |
| Testnet only | by design |
| Nautilus has no attested enclave; decisions from the local tier are labelled unattested | `IMPLEMENTED_LOCAL` |
| CRE decisions arrive through a simulated forwarder | `SIMULATED` / `BLOCKED_AUTH` |
| Wormhole testnet runs a single guardian | upstream |
| Cross-chain revocation is not atomic across endpoints | keep leases short |

## What is not claimed

- That anything ran in an attested TEE.
- That prompt injection is solved — only its financial consequences are bounded.

## Reporting

Open an issue describing the class of problem. For anything that would matter in a production
adaptation, describe the class rather than publishing a working exploit.
