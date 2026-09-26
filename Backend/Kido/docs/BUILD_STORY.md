# Build story

What was actually hard, what went wrong, and what changed because of it. Written for the "how did
you build it" section of a submission, and kept honest enough to be useful afterwards.

---

## The idea came from a bug class, not a product gap

The starting point was the **confused deputy**: give a component authority, let someone else supply
its instructions, and it will use your authority for their purpose. Prompt injection is that bug
with a new delivery mechanism — the instruction arrives inside the data the agent was asked to
read.

Every "AI agent with a wallet" design has this shape. The two standard mitigations are a spending
cap, which answers only *how much*, and a better system prompt, which asks the component under
attack to defend itself.

So the design constraint was fixed before any code: **the agent must not hold a key, and no
security decision may depend on the agent behaving well.** Every subsequent choice falls out of
that.

---

## Six things that were harder than expected

### 1. EIP-712 gives you no replay protection

A common misreading, and it would have been a critical bug. Typed data proves *who signed what*; it
says nothing about *how many times*. Replay protection is supplied separately by an on-chain nonce,
an independent `approvedUntil`, and live-state checks that re-read ENS and the authorization
registry at execution time.

The capability struct ended up with **fifteen** signed fields. That triggered stack-too-deep, and
the fix was to enable `via_ir` rather than shrink a security-relevant schema. Compile time got
worse; the schema stayed correct.

### 2. Tests that could not fail

`Capability memory m = cap` **aliases** in Solidity. Every mutation test was comparing an object to
itself and passing regardless. An explicit `_copy()` fixed it (FND-006).

Separately, `vm.expectRevert` was armed against the wrong call: the test helper's internal
`executor.DOMAIN_SEPARATOR()` consumed the expectation before the call under test ran (FND-007).

Both were tests reporting green while proving nothing. That produced the discipline the rest of the
project runs on: **a negative test is not evidence until it has been observed to fail on demand.**
Every scanner in this repository is verified with a planted canary in both directions.

That discipline paid for itself in Phase 9 — see below.

### 3. Three live ENSv2 deployments that disagree (FND-008, HIGH)

Sepolia has multiple ENSv2 deployments live simultaneously, and the published documentation does
not disambiguate them. Picking the wrong registry means the identity checks silently verify against
a registry nobody uses.

Resolved by probing **migrated-name occupancy** — checking which registry actually holds names that
should have migrated. The rejected alternates are recorded in `packages/ens/src/deployments.ts`
rather than deleted, because the next person hits the same fork in the road.

Then a second surprise: the stock `PermissionedRegistry` has ten roles and **none of them are
financial**, and the name owner does not hold `ROLE_UNREGISTER`, so `unregister()` reverts
(FND-009). That looked like a dead end and turned into the best mechanism in the project: revoking a
role **regenerates the name's token id**, which changes the identity hash, which invalidates every
outstanding capability bound to it. Revocation-kills-outstanding-authority is now the ENS demo, and
it exists because the obvious lever didn't work.

### 4. A CRE bug that would have failed identically on the live network (FND-012)

The EVM log trigger delivers a **raw protobuf `Log`**, not the decoded event struct the workflow
assumed. In the simulator this presented as confusing data; on a live DON it would have failed the
same way. Fixed with `decodeEventLog`, and the test harness was rebuilt to emit genuinely encoded
logs rather than convenient objects — a fixture that lies is worse than no fixture.

Two permanent regression tests exist so the assumption cannot quietly return.

Nearby: `eth_getLogs` has a 10-block range cap that returned **empty results silently** rather than
erroring (FND-013). Events are now addressed by transaction hash.

### 5. A dependency that installs something else entirely (FND-011)

`npx wallet-cli` installs an **unrelated third-party package** whose command surface accepts a raw
private key. The intended package is the scoped `@ledgerhq/wallet-cli`.

An agent — or a hurried human — following a plausible-looking instruction would hand a private key
to an unknown package. The code now resolves an explicit `cliPath` and never trusts `PATH`.

### 6. The scanners drifted, and only a clean clone caught it (FND-017, FND-018)

In Phase 9, running the suite from a genuine `git clone` into an empty directory produced two
failures that the working tree had never shown:

- the privilege audit flagged the operator console — for a **display string** naming a variable in
  order to assert the agent cannot reach it;
- the canary scanner flagged a legitimate test fixture added a phase earlier, because its allowlist
  named one filename **literally**.

Neither was a leak. The real finding is that **CONF-001 had been failing since Phase 8 while being
reported CLEAN**. No amount of re-reading the code found it. A clone into an empty directory found
both in one run.

Both fixes were made stricter than the failure required. The privilege audit now allows `apps/web/`
to *name* privileged variables and forbids it from reading **any** environment variable at all —
a tighter surface than before the finding. The canary allowlist was widened to one directory's test
files only, and the negative control specifically confirms a non-test file in that same directory
still fails.

---

## Three decisions worth defending

**Three verdicts, not two.** Binary authorization forces every threshold to be a cliff: either the
autonomous limit is uselessly low, or a compromised agent gets a large budget. ALLOW / ESCALATE /
DENY lets the autonomous limit stay low while larger actions remain possible with a human accepting
the specific risk.

**DENY is structurally terminal.** Not "ESCALATE with more friction" — there is no path from DENY to
execution. Proven live: a genuine, valid human approval was recorded on Sepolia for a DENIED
capability and execution was **still** refused, with the approval never even read. Human approval
escalates autonomy; it cannot override policy.

**Inexpressible beats refused.** Six of the nine security properties aren't enforced by a check that
says no — there is no request the agent can construct that reaches the question. The secret broker
has `performProtectedAction` and **no `getSecret` at all**. An interface with no verb for leaking
cannot be talked into leaking.

---

## What did not get finished

**No physical Ledger device was ever available (BLK-002, OPEN).** The integration software is
complete and tested and the on-chain approval boundary is proven live with a stand-in key — but no
Key Ring was provisioned, no human approved anything on hardware, and no ERC-7730 descriptor was
rendered on a device screen. `npm run test:ledger:hardware` **fails loudly** rather than skipping or
mocking, and the Ledger prize is not claimed.

**Chainlink ran in the official CLI simulator, not on a live DON, and not in a TEE.** Confidential
Workflows live access is invite-only private beta (FND-001). `docs/CRE_MODE_BASELINE.md` is the
authoritative record and every other document defers to it.

Eighteen findings are recorded: twelve fixed, four accepted risks, two open. Nothing was closed to
make the status look better, and the two Slither High findings are documented as design-inherent
rather than suppressed.
