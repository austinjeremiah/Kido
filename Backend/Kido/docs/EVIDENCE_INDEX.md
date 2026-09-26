# Evidence index

Every claim this project makes, and the file or transaction that supports it. Ordered by claim, not
by phase, so a reader can check one thing without reading ten reports.

**The rule this index follows:** if a claim has no artifact, it is listed as *not evidenced* rather
than omitted.

---

## 1. Live on Sepolia

| Claim | Evidence |
|---|---|
| Contracts deployed | `deployments/sepolia.json` · `reports/phase-03/evidence/p3-sepolia-deploy.txt` · `reports/phase-07/evidence/p7-sepolia-deploy.txt` |
| Bytecode matches source | `reports/phase-03/evidence/p3-bytecode-verification.txt` · `reports/phase-07/evidence/p7-bytecode.txt` |
| Chain is Sepolia (11155111) | asserted in every deploy/demo script; `reports/phase-00/evidence/p0-chain.txt` |
| Canonical executor | `0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23` |
| Superseded executor, retained | `0xe109686a0a10b0FC8f090F2bBd1424C50fE2920a` (phases 03–06) |

## 2. ENS — identity and revocation

| Claim | Evidence |
|---|---|
| ENSv2 name registered | tx `0xbf1eb7294b45fa48ca7fb30ac24f7d540716d23f91fa977ea42245e87eb09705` |
| Identity bound on-chain | tx `0x6d36603d6682ae229c0c65a4a419e37c2a79cea03fc484bbbb29fdbdd7b348a5` |
| Registration walkthrough | `reports/phase-03/evidence/p3-ens-registration.txt` |
| Identity read live, never cached | `apps/broker/test/ens-live.test.ts` · `reports/phase-03/evidence/p3-live-ens-tests.txt` |
| **Revocation kills unexpired authority** | tx `0x32d72d1394217f9a033fef1c74a1fb4cea13f59dcaf58d81af5115da1bbf15bc` · `reports/phase-09/evidence/p9-demo-all.txt` (DEMO-ENS-REVOKE → `IdentityNotCurrent`) |
| Three deployments disagreed | `reports/phase-03/findings/FND-008-*` (HIGH) |
| Owner lacks `ROLE_UNREGISTER` | `reports/phase-03/findings/FND-009-*` |
| Fresh namespace; no personal name touched | `contextlock-20260906-a83dc9.eth`, registered 2026-09-06 |

## 3. Chainlink CRE — confidential policy

| Claim | Evidence |
|---|---|
| Workflow executed in the **official CLI simulator** | `reports/phase-04/evidence/p4-cre-simulator.txt` · CLI v1.32.0 · binary `800d0d56…00e0` |
| Triggered by **real Sepolia events** | `reports/phase-04/evidence/p4-cre-live.txt` · `reports/phase-04/test-results/p4-live-results.json` |
| **Same tx, 4 verdicts, only private context differs** | `reports/phase-08/evidence/p8-private-context-proof.txt` — tx `0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843` |
| No confidential value crosses the boundary | `reports/phase-08/evidence/p8-canary-scan.txt` (CONF-001, 5 surfaces) |
| Authoritative execution-mode record | `docs/CRE_MODE_BASELINE.md` · `reports/phase-04/CRE_MODE.md` |
| CLI auth blocker, resolved | `reports/phase-04/blockers/BLK-001-*` — **RESOLVED** |
| Raw protobuf `Log`, not decoded struct | `reports/phase-04/findings/FND-012-*` |
| `eth_getLogs` 10-block cap | `reports/phase-04/findings/FND-013-*` |

### Explicitly **not** evidenced — because it did not happen

| | |
|---|---|
| Execution in a real TEE / AWS Nitro | **No artifact exists.** `REAL_TEE_EXECUTION=NO` |
| Deployment to the live CRE network | **No artifact exists.** `cre whoami` → `Deploy Access: Not enabled` |
| A DON-signed report | **No artifact exists.** |
| Vault DON secret release | **No artifact exists.** |

## 4. Ledger — software only

| Claim | Evidence |
|---|---|
| Key Ring / secret-broker software | `packages/ledger/src/` · `reports/phase-06/evidence/p6-keyring-tests.txt` |
| Secret broker exposes **no getter** | `scripts/privilege-audit.sh` check [7] · `reports/phase-08/evidence/p8-privilege-audit.txt` |
| ERC-7730 descriptor authored | `packages/ledger/erc7730/contextlock-approval.json` · 7 tests |
| Clear Signing status, stated honestly | `reports/phase-07/CLEAR_SIGNING_STATUS.md` |
| Approval registry, on-chain boundary | `contracts/test/HumanApproval.t.sol` (16 LED-H tests) |
| ESCALATE blocked without approval | `reports/phase-09/evidence/p9-demo-all.txt` → `HumanApprovalRequired` |
| ESCALATE + approval executes | tx `0x74b83bfb1b7a7dd81793029202754b36c14fcf0b2d85cb901883e19141148015` |
| **Valid approval cannot rescue DENY** | approval tx `0xc3b7d55d4fc903a935fea084c297f57060674ba71dccb69fa66d961ff0f644da` → still `AuthorizationNotAllow` · `reports/phase-07/evidence/p7-escalation-live.txt` DEMO-C |
| `npx wallet-cli` name collision | `reports/phase-06/findings/FND-011-*` |

### Explicitly **not** evidenced — because no device existed

| | |
|---|---|
| Key Ring provisioned on hardware | **No artifact exists.** BLK-002 |
| A human approved on a device | **No artifact exists.** BLK-002 |
| ERC-7730 rendered on a device screen | **No artifact exists.** BLK-002 |
| The suite fails rather than mocking | `reports/phase-10/evidence/p10-ledger-hardware-attempt.txt` — **exit 1**, 7 tests listed as BLOCKED |

The approver key is labelled `STAND-IN — NOT LEDGER-HELD` in `deployments/sepolia.json`, in the
demo output, and in the UI. No hardware-mocked test is described as hardware evidence anywhere.

## 5. Security properties

| Property | Evidence |
|---|---|
| Capability mutation rejected | `contracts/test/Fuzz.t.sol` (512 runs, all 15 fields) · demo → `CalldataHashMismatch` |
| Replay rejected | `contracts/test/Adversarial.t.sol` · demo → `NonceUsed` |
| Cross-domain / cross-deployment replay rejected | `contracts/test/RedTeam.t.sol` |
| Authorization forgery rejected | `NotAuthorizer` / `NotForwarder`, live |
| Self-approval impossible | `onlyExecutor` consumption · `HumanApproval.t.sol` |
| DENY terminal | DEMO-C, above |
| Agent cannot reach any credential | `reports/phase-08/evidence/p8-privilege-audit.txt` |
| Prompt injection corpus (18 intents) | `apps/demo-agent/src/hostile-corpus.ts` · `reports/phase-08/RED_TEAM_REPORT.md` |
| Full attack mapping | `reports/phase-08/ATTACK_MATRIX.md` (20 surfaces) |
| Independent schema cross-check | `contracts/test/GoldenVectors.t.sol` + `packages/protocol/test-vectors/` (16 vectors) |

## 6. Testing and scanners

| | Evidence |
|---|---|
| **266 passed · 0 failed · 1 skipped** | `reports/phase-10/evidence/p10-final-regression.txt` · `reports/phase-09/TEST_RESULTS.md` |
| Full Phase 8 regression | `reports/phase-08/evidence/p8-full-regression.txt` |
| Secret scan | `reports/phase-08/evidence/p8-secret-scan.txt` |
| Confidential canary scan | `reports/phase-08/evidence/p8-canary-scan.txt` |
| Privilege audit | `reports/phase-08/evidence/p8-privilege-audit.txt` |
| Static analysis (Slither) | `reports/phase-08/evidence/p8-static-analysis.txt` · triage in FND-016 |
| Supply chain | `reports/phase-08/evidence/p8-supply-chain.txt` · FND-015 |
| Reproducible clean install | `docs/CLEAN_INSTALL.md` |
| Scanners proven able to fail | negative controls recorded in FND-017, FND-018 |

## 7. Findings and blockers — complete

Eighteen findings. **Twelve fixed, four accepted risks, two open.** Two blockers: one resolved, one
open.

| ID | Severity | Status | Where |
|---|---|---|---|
| FND-001 | — | **ACCEPTED_RISK** | phase-00 — CRE Confidential Workflows private beta |
| FND-002 | — | **OPEN** | phase-00 — Ledger Key Ring network-dependency doc drift |
| FND-003 | — | FIXED | phase-00 — ENS EAC has no financial role |
| FND-004 | — | **OPEN** | phase-00/04 — Chainlink challenge config dated/closed |
| FND-005 | — | **ACCEPTED_RISK** | phase-01 — nonce consumed on success, not attempt |
| FND-006 | — | FIXED | phase-01 — Solidity memory struct aliasing in tests |
| FND-007 | — | FIXED | phase-02 — throwing validator became HTTP 500 |
| FND-008 | HIGH | FIXED | phase-03 — three ENSv2 Sepolia deployments |
| FND-009 | — | FIXED | phase-03 — owner lacks `ROLE_UNREGISTER` |
| FND-010 | — | FIXED | phase-04 — gateway blocked re-evaluation |
| FND-011 | — | FIXED | phase-06 — `wallet-cli` name collision |
| FND-012 | — | FIXED | phase-04 — EVM log trigger delivers raw `Log` |
| FND-013 | — | **ACCEPTED_RISK** | phase-04 — `eth_getLogs` range limit |
| FND-014 | MEDIUM | FIXED | phase-08 — zero address accepted as recipient |
| FND-015 | HIGH+CRIT | FIXED | phase-08 — vulnerable fastify / vitest |
| FND-016 | INFO | **PARTIAL / ACCEPTED_RISK** | phase-08 — Slither: 2 High design-inherent |
| FND-017 | LOW | FIXED | phase-09 — privilege audit flagged own prose |
| FND-018 | LOW | FIXED | phase-09 — canary allowlist missed a fixture |

| Blocker | Status | |
|---|---|---|
| BLK-001 | **RESOLVED** | CRE CLI authentication |
| BLK-002 | **OPEN** | No physical Ledger device — blocks all P6/P7 hardware evidence |

## 8. Phase gate records

| Phase | Verdict | Handoff |
|---|---|---|
| 00 Preflight | PASS | `reports/phase-00/HANDOFF.md` |
| 01 Contracts | PASS | `reports/phase-01/HANDOFF.md` |
| 02 Broker | PASS | `reports/phase-02/HANDOFF.md` |
| 03 ENS live | PASS | `reports/phase-03/HANDOFF.md` |
| 04 Chainlink CRE | PASS | `reports/phase-04/HANDOFF.md` |
| 05 Demos | PASS | `reports/phase-05/HANDOFF.md` |
| 06 Ledger Key Ring | **BLOCKED** (BLK-002) | `reports/phase-06/HANDOFF.md` |
| 07 Escalation + Clear Signing | **PARTIAL** (BLK-002) | `reports/phase-07/HANDOFF.md` |
| 08 Red team | **PASS_NON_LEDGER** | `reports/phase-08/HANDOFF.md` |
| 09 Release candidate | **RC_READY_PENDING_LEDGER** | `reports/phase-09/HANDOFF.md` |
| 10 Submission package | **SUBMISSION_READY_PENDING_LEDGER** | `reports/phase-10/HANDOFF.md` |

No phase is marked PASS where hardware evidence was required and absent.

## 9. AI usage

`AI_USAGE.md` — what was AI-generated, what was human-specified, and how it was verified.
`FEEDBACK_LEDGER.md` — ecosystem feedback raised during the build.
