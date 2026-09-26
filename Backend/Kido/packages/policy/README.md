# @contextlock/policy

**One policy implementation, two execution sites.**

This package holds ContextLock's deterministic ALLOW / ESCALATE / DENY decision function. It is
imported by exactly two consumers:

1. `workflows/cre-policy/contextlock-policy/workflow.ts` — runs it **inside the CRE TEE handler**.
2. `apps/broker/src/providers/cre-evaluator.ts` — runs it in the broker when CRE is not live.

Keeping it here rather than duplicating it is the point: a divergence between "what the enclave
decides" and "what the broker decides" would be a silent security hole, and duplication is how
that happens.

The function is pure, total and deterministic. CRE verifies enclave results by DON consensus, so a
non-deterministic decision would fail consensus.

**This code is not secret and is not claimed to be.** Current CRE documentation is explicit that
the workflow binary — including this logic — is provided to the enclave by the Workflow DON. What
the enclave keeps confidential is the *data*: Vault DON secrets, enclave HTTP payloads, and
intermediate values. Only the private policy **values** are confidential.
