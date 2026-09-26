# AI Usage Attribution

ETHOnline 2026 permits AI coding tools where their use is clearly documented, and requires that
spec-driven workflows keep their specs, prompts and planning artifacts in the submission
repository. This file is that disclosure.

## Tools used

| Tool | Model | Where used |
|---|---|---|
| Claude Code (Anthropic CLI) | Claude Opus 5 (1M context) | Primary implementation agent for all phases |
| OpenAI API | `gpt-5.6-luna` | **Runtime component only** — powers the intentionally untrusted demo agent in `apps/demo-agent`. Not used to write project code. |

## How AI was used

The project is built spec-first. The human author wrote the architecture and security
specification (`specs/CONTEXTLOCK_BUILD_BIBLE.md`) and the execution discipline
(`specs/AGENT_GAUNTLET.md`) before implementation. The coding agent implements against those
documents phase by phase, and each phase must pass a gate with recorded positive **and**
adversarial evidence before the next phase begins.

The agent was explicitly instructed that official sponsor documentation outranks the
specification. Where the two disagreed, the agent filed a documentation-drift finding
(`reports/phase-*/findings/FND-*`) citing the exact API difference before changing any code.

## What AI did **not** decide

- Security invariants. These come from the bible and are enforced by tests, not by model judgment.
- Authorization outcomes at runtime. ContextLock's whole thesis is that **no LLM is in the
  authorization path**. The deterministic executor is the reference monitor. The demo agent is
  assumed compromised by design.
- Sponsor API shapes. Every sponsor interface was read from current official docs and, where
  on-chain, verified by bytecode probe before use.

## Planning artifacts retained

- `specs/CONTEXTLOCK_BUILD_BIBLE.md` — full architecture and security specification
- `specs/AGENT_GAUNTLET.md` — phase/gate execution discipline given to the agent
- `specs/ENV_REQUIRED.md` — operator input contract
- `specs/SOURCES_AND_DOCS.md` — source manifest
- `docs/REFERENCE_MANIFEST.md` — annotated bibliography with verification status
- `reports/phase-XX/DECISIONS.md` — per-phase scope decisions made before coding
- `reports/phase-XX/HANDOFF.md` — per-phase gate evidence
- `reports/phase-XX/findings/` — every discovered fact, kept even after it is fixed

## Human-in-the-loop

The human author supplied the specification, the testnet funding key, the ENS registration
authorization, and the phase-gate go-ahead. All keys used are disposable Sepolia testnet keys.
No mainnet key, personal wallet, or Ledger seed material was ever provided to the agent.

---

## Final disclosure (P10.7)

Added at the end of the build so the record reflects what actually happened, not what was planned.

### Division of authorship

| | |
|---|---|
| **Human-authored** | The specification (`specs/`), the security invariants, the phase discipline, the constraint that no LLM sits in the authorization path, all key material, and every go/no-go decision at a phase gate. |
| **AI-authored** | Substantially all implementation: Solidity, TypeScript, tests, scripts, documentation and reports — written against the specification and verified by the gates. |
| **Neither** | Sponsor API shapes. These were read from current official documentation and, where on-chain, confirmed by bytecode probe. Where documentation and reality disagreed, a finding was filed before code changed. |

### Where AI judgment was overridden by evidence

Recording these matters more than the summary, because they are the cases where the agent's first
answer was wrong and something external corrected it:

- **FND-006 / FND-007** — tests that passed while proving nothing (Solidity memory aliasing; a
  revert expectation armed against the wrong call). Found by deliberately trying to make each
  negative test fail. This established the project's standing rule: **a negative test is not
  evidence until it has been observed to fail on demand.**
- **FND-008** — three live ENSv2 Sepolia deployments disagreed with each other and with the docs.
  Resolved by probing on-chain state, not by trusting any document.
- **FND-012** — the CRE workflow assumed a decoded event struct; the trigger delivers a raw
  protobuf `Log`. It would have failed identically on a live DON. Found by building a test harness
  that emits genuinely encoded logs instead of convenient objects.
- **FND-014** — the zero address was accepted as a transfer recipient. Found by **fuzzing**, not by
  reasoning. No hand-written test would have asked the question, because it tested something the
  agent *was* permitted to do.
- **FND-017 / FND-018** — two security scanners were reported CLEAN while failing. Found by running
  the suite from a **clean clone**, not by re-reading code. One had been failing since Phase 8, and
  the earlier status line was wrong. It is corrected in `reports/phase-09/HANDOFF.md` rather than
  silently overwritten.

The pattern is consistent and worth stating plainly: the useful corrections came from **executing
things in an unfamiliar environment**, not from more careful reading.

### What the AI was not permitted to do

- Simulate, mock, or infer missing hardware evidence. BLK-002 remains open and every Ledger
  artifact says so.
- Label a simulator run as a live deployment, local encryption as a Ledger Key Ring, or an ordinary
  Node function as a Confidential Workflow.
- Mark a phase PASS where required hardware evidence was absent. Phase 6 is BLOCKED and Phase 7 is
  PARTIAL for exactly this reason.
- Close a finding to improve the appearance of the status. Four accepted risks and two open
  findings remain recorded.
- Touch mainnet, or use any personal ENS name.

### Runtime AI

`gpt-5.6-luna` powers the demo agent in `apps/demo-agent` and is **assumed hostile**. It is fed an
18-intent prompt-injection corpus. It holds no key, declares one dependency (`viem`), cannot import
a signer, and cannot reach broker internals — enforced by `scripts/privilege-audit.sh`.

No LLM appears anywhere in the authorization path. The reference monitor is deterministic Solidity,
and the policy decision is a deterministic TypeScript function with exactly one implementation.
