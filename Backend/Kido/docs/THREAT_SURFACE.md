# ContextLock Threat Surface

Twenty surfaces, each with the asset at risk, who attacks it, what we *assume* about it, the
attack, the mitigation, the test that proves the mitigation, and what risk remains.

The framing throughout: **the AI agent is assumed compromised.** A mitigation that depends on the
model behaving well is not a mitigation.

Status key — `SW` software test · `SIM` CRE simulator · `LIVE` live Sepolia · `BLK` blocked by BLK-002.

---

## 1. AI / prompt layer

| | |
|---|---|
| **Asset** | Nothing directly. The agent holds no key and no authority. |
| **Attacker** | Prompt injector via any external content the agent reads. |
| **Trust assumption** | **None.** The model is assumed fully controllable by an attacker. |
| **Attack** | Convince the model to emit any request it can express. |
| **Mitigation** | The model is not in the authorization path. Every decision is made by the deterministic policy evaluator and re-checked on-chain by the executor. |
| **Test** | ADV-001/002, PI-001…PI-018 (`prompt-injection.test.ts`) — `SW` |
| **Residual** | The agent can waste gas proposing requests that are denied. Rate limiting is future work. |

## 2. Agent tool interface

| | |
|---|---|
| **Asset** | The set of actions the agent can even name. |
| **Attacker** | Compromised agent runtime. |
| **Trust assumption** | Anything reachable through the tool surface will eventually be called with hostile arguments. |
| **Attack** | Call an unintended method; pass a raw `target`/`calldata`; reach a Key Ring command. |
| **Mitigation** | Typed adapters only. No generic-call adapter. `SecretProvider` exposes `performProtectedAction`, never `getSecret`. No argument passthrough to any CLI. |
| **Test** | API-003, LED-004, LED-012-KR — `SW` |
| **Residual** | A new adapter added carelessly could widen this. Adapter review is a process control, not a technical one. |

## 3. Broker HTTP API

| | |
|---|---|
| **Asset** | Request pipeline integrity; availability. |
| **Attacker** | Anyone who can reach the broker. |
| **Trust assumption** | All input is hostile and possibly malformed. |
| **Attack** | Malformed JSON, wrong types, huge numbers, unicode/null bytes, oversized bodies, deep nesting, unexpected fields, replay. |
| **Mitigation** | Zod `.strict()` schemas; total validators (never throwing); typed reason codes; operational failure (503) kept distinct from policy denial (200 DENIED). |
| **Test** | FUZZ-001…FUZZ-018 (`fuzz.test.ts`), API-001/002/003 — `SW` |
| **Residual** | No auth on the broker API in the MVP — it is a testnet demo surface. Production needs operator authentication. |

## 4. Broker → ENS

| | |
|---|---|
| **Asset** | Correctness of the agent identity used for issuance. |
| **Attacker** | Malicious RPC; network partition; a revoked agent racing issuance. |
| **Trust assumption** | The RPC may lie, hang, or return garbage. |
| **Mitigation** | No cache that can outlive a revocation (asserted structurally). Every read failure raises `OperationalError` and fails closed. Crucially, the broker's answer is **advisory** — the executor re-checks on-chain. |
| **Test** | ID-006, ENS-ATK-001…006 — `SW`/`LIVE` |
| **Residual** | A malicious RPC can deny service. It cannot forge an identity the executor will accept. |

## 5. Broker → CRE

| | |
|---|---|
| **Asset** | The policy verdict. |
| **Attacker** | Compromised broker; malicious relayer. |
| **Trust assumption** | The broker may be compromised. |
| **Mitigation** | The verdict the executor honours is the one recorded **on-chain** by the restricted consumer, bound to a request hash the executor recomputes itself. |
| **Test** | CRE-003/005/007/009, AUTH-ATK-001…009 — `SW`/`LIVE` |
| **Residual** | While `CRE_MODE=simulator`, no live DON writes the report; the configured forwarder is a stand-in. Documented, not hidden. |

## 6. CRE event decoder

| | |
|---|---|
| **Asset** | Fidelity between the on-chain event and what the policy rules on. |
| **Attacker** | Anyone who can emit a log, or craft one. |
| **Trust assumption** | The trigger delivers **raw bytes**, not a trusted struct (FND-012). |
| **Attack** | Wrong event signature, missing/extra topics, truncated or oversized data, wrong emitter, injected fields. |
| **Mitigation** | `decodeEventLog` against the exact ABI. A malformed log throws and the workflow produces no verdict. An ABI-encoded log has no room for an injected field. |
| **Test** | **CRE-RAW-LOG-001/002**, CRE-DEC-001…008 — `SW` |
| **Residual** | The workflow does not verify the emitter address itself; that check belongs to the trigger filter, which is configured with the gateway address. Recorded as FND-014. |

## 7. CRE confidential policy

| | |
|---|---|
| **Asset** | Private thresholds; the verdict. |
| **Attacker** | Node operators (in a real DON); anyone reading logs or reports. |
| **Trust assumption** | Workflow **source and binary are public**; only *data* is confidential. |
| **Mitigation** | Only verdict, reason code, band and commitments cross `usingTheDons()`. Zero `runtime.log()` calls. Fixed-width report payload. |
| **Test** | CONF-001 (5 surfaces), CONF-SIM-001…003 — `SW`/`SIM` |
| **Residual** | In `simulator` mode there is no enclave, so confidentiality is a property of the code, not of hardware. Stated explicitly everywhere. |

## 8. AuthorizationRegistry

| | |
|---|---|
| **Asset** | The authority to say ALLOW. |
| **Attacker** | Any EOA; a rotated-out writer; the relayer. |
| **Trust assumption** | Only the configured consumer may write. |
| **Attack** | Direct write; duplicate/overwrite; upgrade DENY→ALLOW; forge an authorization for another request. |
| **Mitigation** | `onlyAuthorizer`; write-once records; consumer derives the authorization id rather than accepting one; executor recomputes the request hash. |
| **Test** | CRE-007, AUTH-ATK-001…009 — `SW`/`LIVE` |
| **Residual** | The registry owner can repoint the writer. That is a governance key, and its compromise is out of scope for the MVP. |

## 9. Capability issuer

| | |
|---|---|
| **Asset** | The EIP-712 signing key. |
| **Attacker** | Compromised broker process. |
| **Trust assumption** | A hot key in the MVP; production should be HSM/threshold/ERC-1271. |
| **Mitigation** | Separate key from deployer/relayer/agent; never in a response or audit record; agent package structurally cannot reach it. |
| **Test** | AGENT-BND-001…006, ISSUER-001/002 — `SW` |
| **Residual** | **Accepted:** issuer compromise lets an attacker mint capabilities — but they still cannot bypass ENS, policy, or CRE authorization. Blast radius is bounded, not zero. |

## 10. EIP-712 encoding

| | |
|---|---|
| **Asset** | Meaning of a signature. |
| **Attacker** | Replay across chain, contract, or deployment. |
| **Trust assumption** | EIP-712 provides **no** replay protection. |
| **Attack** | Reuse a signature on another chain, another executor, an old executor, or a mutated struct. |
| **Mitigation** | `chainId` + `verifyingContract` in the domain **and** in the struct; nonce; expiry; 16 cross-language golden vectors. |
| **Test** | CAP-005/005b/006, D712-001…008 — `SW` |
| **Residual** | None known. Redundant binding is deliberate. |

## 11. Relayer

| | |
|---|---|
| **Asset** | Transaction submission. |
| **Attacker** | The relayer itself. |
| **Trust assumption** | **Untrusted.** `msg.sender` is unconstrained by design. |
| **Attack** | Withhold, reorder, replay, or front-run a submission. |
| **Mitigation** | All authority is inside the signed capability. A malicious relayer can delay but not alter or duplicate execution. |
| **Test** | CAP-009/010, NONCE-ATK-001…007 — `SW`/`LIVE` |
| **Residual** | A relayer can censor. Any party may submit, so censorship is not exclusive. |

## 12. Executor

| | |
|---|---|
| **Asset** | Everything. This is the reference monitor. |
| **Attacker** | All of the above simultaneously. |
| **Trust assumption** | Trusted, and therefore kept boring and immutable. |
| **Attack** | Reentrancy, mutation, replay, stale authorization, revoked identity, disabled policy, DENY escalation. |
| **Mitigation** | Nine ordered validation groups, all before any external interaction; reentrancy guard; nonce consumed pre-call; `HumanApprovalRequired` only on the ESCALATE branch. |
| **Test** | CAP-001…012, ADV-003/004/008, TGT-ATK-001…006, LED-H19 — `SW`/`LIVE` |
| **Residual** | Not audited. No emergency pause and no issuer rotation — both recorded limitations. |

## 13. Policy Registry

| | |
|---|---|
| **Asset** | Public financial authority. |
| **Attacker** | The agent; a non-admin. |
| **Trust assumption** | Only the policy admin may change authority. |
| **Mitigation** | `onlyAdmin` on every mutator; monotonic binding version; hard value cap enforced on-chain. |
| **Test** | POL-001…004, POL-ATK-001…008 — `SW`/`LIVE` |
| **Residual** | Policy-admin key compromise is out of scope; modelled in POL-ATK-008 to show blast radius. |

## 14. ENS verifier

| | |
|---|---|
| **Asset** | Live identity truth at execution time. |
| **Attacker** | A revoked agent; a stale cache; a failing registry. |
| **Trust assumption** | ENSv2 registry state is authoritative and read **at execution**. |
| **Mitigation** | `ownerOf` (never `latestOwnerOf`); token-id binding so a role change is an identity change; every failure path returns false. |
| **Test** | ID-001…006, DEMO-004, ENS-ATK-001…006 — `LIVE`/fork |
| **Residual** | ENSv2 is beta; interfaces may change. Version-pinned and isolated behind one interface. |

## 15. Target contracts

| | |
|---|---|
| **Asset** | Executor state integrity; nonce semantics. |
| **Attacker** | A malicious or upgraded allowlisted target. |
| **Trust assumption** | Targets are allowlisted but **not** trusted to behave. |
| **Attack** | Reentrancy, revert, gas exhaustion, malformed return, hostile callback. |
| **Mitigation** | Reentrancy guard; nonce marked before the call; no return-data interpretation; policy allowlist. |
| **Test** | ADV-008, TGT-ATK-001…006 — `SW` |
| **Residual** | **Accepted:** an allowlisted target can still do economically bad things within its permission. ContextLock validates permission, not economic wisdom. |

## 16. RPC / provider

| | |
|---|---|
| **Asset** | Availability and correctness of chain reads. |
| **Attacker** | Malicious or degraded provider. |
| **Trust assumption** | The RPC may fail, rate-limit, or lie. |
| **Attack** | Timeout, 429, invalid JSON, wrong chainId, stale block, range limits (FND-013). |
| **Mitigation** | `assertSepolia()` on every path; typed operational failures; evidence addressed by tx hash, never by range scan. |
| **Test** | RPC-ATK-001…008 — `SW` |
| **Residual** | A lying RPC can deny service to the broker. The executor reads chain state directly, so it cannot be fooled by the broker's provider. |

## 17. Database / audit layer

| | |
|---|---|
| **Asset** | Idempotency and the audit trail. |
| **Attacker** | Duplicate/racing requests; a broker restart mid-flight. |
| **Trust assumption** | **The database is not a source of authority.** |
| **Attack** | Duplicate idempotency key; different body, same key; concurrent inserts; DB unavailable. |
| **Mitigation** | UNIQUE constraint on idempotency key; authority reconstructed from the signed capability plus live chain state; a DB outage blocks issuance rather than creating unaudited authority. |
| **Test** | API-001, DB-ATK-001…008 — `SW` |
| **Residual** | The audit log is not tamper-evident. Production wants append-only storage with integrity proofs. |

## 18. SecretProvider

| | |
|---|---|
| **Asset** | The protected service credential. |
| **Attacker** | The agent; anyone reading logs, errors or the database. |
| **Trust assumption** | The agent will actively try to exfiltrate it. |
| **Attack** | Ask for it directly; induce it into an error message; drive an arbitrary ring command. |
| **Mitigation** | No `getSecret` exists; errors reconstructed from a fixed table; plaintext zeroized; no plaintext fallback; fixed CLI args. |
| **Test** | LED-003…014-KR, EXFIL-001…010 — `SW` |
| **Residual** | **`BLOCKED_BY_BLK_002`** — the credential has never been encrypted by a real Key Ring, so hardware-rooted protection is unproven. |

## 19. HumanApprovalProvider

| | |
|---|---|
| **Asset** | The escalation boundary. |
| **Attacker** | The agent attempting self-approval; an attacker mutating an approved action. |
| **Trust assumption** | Only the configured approver's signature counts. |
| **Attack** | Self-approve; replay; mutate after approval; use an approval to rescue a DENY. |
| **Mitigation** | Approval bound to the capability digest; single-use; independently expiring; `onlyExecutor` consumption; the approval branch is unreachable from DENY. |
| **Test** | LED-H01…H19 — `SW`/`LIVE` |
| **Residual** | **`BLOCKED_BY_BLK_002`** — LED-H03/H04/H15/H16 need a physical device. The signature in live scenes came from a stand-in key. |

## 20. Ledger integration boundary

| | |
|---|---|
| **Asset** | The claim that hardware protects secrets and gates high-risk actions. |
| **Attacker** | Anyone auditing the claim. |
| **Trust assumption** | Claims must be backed by device evidence. |
| **Attack** | Overstate: call local encryption "Key Ring", or a stand-in signature "hardware approval". |
| **Mitigation** | Device-dependent tests report **SKIPPED**, never PASS. The stand-in approver is labelled in the manifest, live output and evidence JSON. `CLEAR_SIGNING_STATUS=device_unavailable`. |
| **Test** | Honest labelling is itself checked: `p8-labelling.test.ts` scans reports for forbidden claims. |
| **Residual** | **`BLOCKED_BY_BLK_002`.** Ledger prize qualification is **not** claimed. |

---

## Cross-cutting residual risks

1. **Issuer key is hot** (surface 9). Bounded blast radius, but real.
2. **No emergency pause / issuer rotation** on the executor.
3. **Nonce rolls back on target revert** (FND-005) — accepted; consumption is on success, not on attempt.
4. **Not audited.** ENSv2 and CRE Confidential Workflows are both beta.
5. **CRE is simulator, not live** — see `docs/CRE_MODE_BASELINE.md`.
6. **No Ledger hardware evidence** — BLK-002.
