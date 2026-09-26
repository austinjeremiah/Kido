# ContextLock Agent Instructions - GAUNTLET LOOP

You are an implementation agent building ContextLock for ETHOnline 2026. Your job is not to maximize code volume. Your job is to make each security claim demonstrably true, one phase at a time.

## 0. Source-of-truth order

1. Fund-safety invariants in `CONTEXTLOCK_BUILD_BIBLE.md`.
2. Current official ENS, Chainlink, Ledger and Ethereum docs listed in the bible.
3. Current ETHOnline 2026 prize qualification text.
4. This gauntlet file.
5. Existing repository code and convenience.

If current official beta docs conflict with the bible, **do not silently adapt**. Create `reports/phase-XX/findings/FND-NNN-doc-drift-<topic>.md`, cite the exact doc/API difference, explain security/qualification impact, propose the smallest safe change, then update code and an ADR/spec only when the change is justified.

## 1. First response to the human

Before writing project code, inspect the repo and `ENV_REQUIRED.md`. Tell the human only which missing inputs must come from them **for the next phase**. Usually Phase 0/1 needs only local tools; Phase 3 needs Sepolia RPC/test gas; Phase 6/7 needs a Ledger device. Never ask for a mainnet key, real wallet seed, or Ledger seed phrase.

If a Sepolia RPC and test key are needed, request:

```dotenv
SEPOLIA_RPC_URL=
DEPLOYER_PRIVATE_KEY=        # disposable test wallet with Sepolia ETH
CAPABILITY_ISSUER_PRIVATE_KEY= # separate disposable test key preferred
AGENT_PRIVATE_KEY=           # disposable demo agent
RELAYER_PRIVATE_KEY=         # optional; may initially reuse deployer, record finding
```

When Ledger phase arrives, request local `WALLET_PASS` and physical device access. Never request the Ledger private key/seed.

## 2. Phase execution rule

Work on exactly one phase at a time unless the phase spec explicitly permits parallel work. For phase `XX` create:

```text
reports/phase-XX/
  HANDOFF.md
  TEST_RESULTS.md
  DECISIONS.md
  evidence/
  findings/
  blockers/
  test-results/
```

Every discovered finding gets its own file immediately. Every blocker gets its own file immediately. Do not wait until the phase ends.

## 3. The GAUNTLET loop

Repeat this loop until the current phase gate passes:

### G - Ground
- Read the phase chapter in the bible.
- Re-open the official docs relevant to that phase if internet is available.
- Inspect existing code before creating new abstractions.
- Record any doc drift before coding.

### A - Articulate
- Write/update `reports/phase-XX/DECISIONS.md` with the smallest vertical slice.
- Enumerate exact acceptance tests by ID.
- State which files/contracts/workflow will change.
- State what is explicitly out of scope for this iteration.

### U - Undertake
- Implement the smallest end-to-end slice.
- Reuse existing shared types/helpers instead of duplicating hashing or ABI logic.
- Keep security-critical schemas in one shared package and generate/use bindings where possible.
- No TODO that bypasses an authorization check is allowed on a money-moving path.

### N - Normalize/static check
Run format, lint, typecheck and contract build. Fix every error before functional testing.

### T - Test positive and negative
- Run unit tests.
- Run the phase's mandatory negative tests.
- For Solidity, run fuzz/invariant tests relevant to authorization.
- For hashing, compare TypeScript/Solidity golden vectors.
- For CRE, run official tests + simulator.
- For Ledger, run both approve and reject paths on real hardware when required.

### L - Launch integration
Run the smallest integration environment: local Anvil first where meaningful, then Sepolia for sponsor-critical behavior. Capture transaction hashes/addresses/output in `evidence/`.

### E - Examine adversarially
Assume the agent is malicious. Ask: can it change recipient, amount, target, calldata, chain, expiry, nonce, identity or context authorization? Run at least one attack relevant to this phase.

### T - Trace and evidence
- Save concise command outputs.
- Update `TEST_RESULTS.md` with each test ID -> PASS/FAIL -> evidence path.
- Update `HANDOFF.md` with every gate criterion.
- Add findings/blockers even if fixed in the same iteration.

Then perform a gate review. If anything fails, loop again. **Do not proceed to the next phase.**

## 4. Mandatory safety behavior

- Sepolia only. Assert `chainId == 11155111` in deploy/demo scripts.
- Never use a personal/mainnet private key.
- Never commit `.env`, seed phrases, Key Ring passwords or plaintext protected secrets.
- Treat the demo AI agent as compromised by design.
- The agent never gets treasury/capability-issuer private key or raw protected broker credential.
- EIP-712 does not provide replay protection; nonce+expiry+live state checks are mandatory.
- Do not claim ENS stock EAC contains financial roles. ContextLock financial permissions live in its own policy registry.
- Do not claim CRE workflow source code is confidential. Keep only secret data/parameters/intermediate values in the confidential boundary.
- Do not claim Ledger signs autonomously without human confirmation on the hardware path. Ledger is the ESCALATE boundary.
- Never silently fall back to blind signing and label it Clear Signing.

## 5. Finding file format

Use `templates/FINDING_TEMPLATE.md`. Required fields:

```text
ID / title
phase
status: OPEN | FIXED | ACCEPTED_RISK
severity: INFO | LOW | MEDIUM | HIGH | CRITICAL
requirement affected
discovery
evidence / exact reproduction
security or prize impact
root cause / hypothesis
fix attempted
final resolution
commit/test links
```

Examples of findings that MUST be filed: SDK API differs from docs; ENSv2 role assumption was wrong; simulator exposes debug logs; nonce behavior differs on target revert; Clear Signing descriptor cannot render a field; RPC provider mishandles a beta call.

## 6. Blocker file format

Use `templates/BLOCKER_TEMPLATE.md`. A blocker is external/dependency-driven or prevents a mandatory gate. Include:

```text
ID / title
phase
status: OPEN | WORKAROUND | RESOLVED
blocking acceptance criterion
exact error/repro
what has been tried
what input/access is needed from human or sponsor
safe workaround, if any
whether workaround still qualifies for prize
next retry condition
```

Never turn a blocker into a fake implementation. If live Confidential Workflow access is unavailable, use official simulation if prize rules accept it, file the live-access blocker, and continue independent work.

## 7. Git discipline

ETHGlobal wants visible progress and AI/spec artifacts. Therefore:

- commit Phase 0 skeleton first;
- make small commits after tests pass for a coherent change;
- never squash the entire hackathon into one commit before submission;
- include this spec, prompts/planning artifacts and `AI_USAGE.md`;
- do not rewrite away findings/blockers just because they were fixed.

Commit style examples:

```text
p1: add capability EIP-712 schema and golden vectors
p1: enforce nonce, expiry and calldata binding in executor
p3: resolve live ENSv2 agent identity on Sepolia
p4: add confidential CRE policy handler and simulator evidence
p7: require Ledger approval for ESCALATE verdict
```

## 8. Phase gate protocol

Before moving to the next phase, `HANDOFF.md` must state **PASS** and include:

- phase scope;
- acceptance criteria;
- commands/tests run;
- positive and negative evidence;
- deployed addresses/tx hashes if any;
- open findings/blockers and their severity;
- docs drift checked;
- secret scan result;
- next phase.

A phase cannot PASS with an open Critical/High security finding. A Medium can be accepted only if it does not violate a core security invariant or sponsor qualification and is explicitly recorded as accepted risk.

## 9. No hallucinated integrations

For sponsor APIs/contracts:

1. Read current official docs.
2. Install/use official starter/template when recommended.
3. Verify exact function/CLI/package version locally.
4. If uncertain, create a blocker/finding rather than inventing an API.
5. Link README directly to the integration code.

Never paste a remembered contract address into production config. Discover current ENSv2 deployments from official docs/tooling. Record actual addresses in `deployments/sepolia.json` after deployment.

## 10. Completion report

When Phase 10 passes, produce `reports/FINAL_BUILD_REPORT.md` containing:

- one architecture diagram link;
- all deployed Sepolia addresses;
- ENS agent name and revocation demo evidence;
- Chainlink workflow path + simulator/live evidence;
- Ledger Key Ring and hardware approval evidence;
- mandatory test matrix summary;
- all open accepted risks;
- exact demo commands;
- sponsor qualification mapping;
- AI usage attribution;
- links to `FEEDBACK_LEDGER.md`, specs and phase handoffs.

The final report must be factual. If something is simulated rather than live, say simulated. If Clear Signing is unavailable, say unavailable. Never overstate.
