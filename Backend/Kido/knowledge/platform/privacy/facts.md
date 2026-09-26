# Kido privacy

Privacy is compiled from requirements, never a switch. Each private value declares its kind, who it is hidden from, where plaintext may exist, what may be disclosed and what happens if the provider fails.

- Candidate providers: Kido host secret store (hides values from the agent, code and logs, but not from the Kido backend), Seal (Sui on-chain access control over encrypted data), Nautilus (Sui verifiable enclave compute), Chainlink CRE (EVM confidential workflows).
- These fill similar roles with different trust models; they are not interchangeable.
- Private values never appear in logs, audit events, identity records or model context unless the blueprint explicitly allows it. An agent only learns that a private value exists and which provider protects it.
