# Submission checklist (P10.14)

**Status: PREPARED, NOT SUBMITTED.**

Per explicit instruction, no ETHGlobal submission has been created. This is the checklist a human
works through when they decide to submit — every item is a human action.

**Deadline: 13 September 2026, 12:00 PM EDT.**

---

## A. Before anything else — rotate the keys

- [ ] **Rotate every testnet key used during the build.** The scans are clean and the repository
      contains no key, but these keys signed public Sepolia transactions and their addresses are
      published in `deployments/sepolia.json`. Rotate regardless.
- [ ] Confirm the `.env` file is not in any archive, screen recording, or shared folder.

## B. Repository

- [ ] `npm run test:all` → `ALL NON-HARDWARE SUITES PASS`
- [ ] `npm run health` → `HEALTH: READY`
- [ ] `git status` clean; everything intended is committed
- [ ] Push to a public repository
- [ ] Confirm `git ls-files` on the pushed remote shows no `.env`, key, or keystore file
- [ ] Confirm the README renders correctly on the hosting platform (tables, the flow diagram)
- [ ] `LICENSE` present
- [ ] Full checklist: `docs/PUBLIC_REPO_READINESS.md`

## C. Video

- [ ] Recorded per `docs/DEMO_RECORDING_PLAN.md`, live against Sepolia
- [ ] 2–4 minutes (event requirement) — use `docs/demo/DEMO_3MIN.md`
- [ ] **The limitations segment is present, audible, and not truncated**
- [ ] Scrubbed at 2×: no key, seed phrase, `.env` content, or RPC URL with an embedded API key in
      any frame — including tab titles and shell autocomplete
- [ ] Every transaction hash shown resolves on `sepolia.etherscan.io`
- [ ] Nothing in the narration contradicts `docs/CRE_MODE_BASELINE.md`
- [ ] Uploaded and the link is publicly accessible without login

## D. Submission text

Copy from `docs/PROJECT_DESCRIPTIONS.md`:

- [ ] Tagline
- [ ] Short description
- [ ] Full description — **including the "what is not true" section**
- [ ] "How it's made" technical section
- [ ] Repository link
- [ ] Video link
- [ ] Live demo link, if hosting the console

## E. Prize tracks — at most three

Per event rules. Recommended selection, with reasoning:

- [ ] **ENS** — claim. Live on Sepolia, load-bearing, revocation demonstrably invalidates
      outstanding authority.
- [ ] **Chainlink** — claim **with the simulator limitation stated in the submission text itself**,
      not only in the repository. A real confidential workflow whose private parameters change the
      verdict; live DON deployment is not claimed.
- [ ] **Ledger** — **do not claim.** BLK-002 is open. No device, no Key Ring, no hardware approval,
      no on-device Clear Signing render. Claiming it would be false.

If BLK-002 closes before submission, follow the reopening procedure in
`docs/DEMO_RECORDING_PLAN.md` §"If BLK-002 closes" — **all four steps**, including re-recording the
demo and updating every artifact, before the Ledger claim goes anywhere.

Detailed per-sponsor mapping with transaction hashes: `docs/PRIZE_QUALIFICATION.md`.

## F. Required disclosures

- [ ] `AI_USAGE.md` linked from the README and present in the repository
- [ ] Planning artifacts retained in `specs/` (spec-driven-workflow requirement)
- [ ] `docs/SOURCE_PROVENANCE.md` — original vs. third-party
- [ ] `docs/KNOWN_LIMITATIONS.md` linked from the README

## G. Honesty gate — read every line before submitting

Refuse to submit if **any** of these is false:

- [ ] The submission does not claim TEE execution.
- [ ] The submission does not claim a live CRE deployment or a DON-signed report.
- [ ] The submission does not claim any Ledger hardware evidence.
- [ ] The submission does not describe the stand-in approver as a Ledger device.
- [ ] The submission does not describe a hardware-mocked test as hardware evidence.
- [ ] Every transaction hash cited is real and resolves on Sepolia.
- [ ] The test count cited (**266**) matches `npm run test:all`.
- [ ] No finding was closed or omitted to improve the appearance of the status.
- [ ] The known limitations are reachable from the submission, not only from the repository.

If any statement in the submission conflicts with `docs/CRE_MODE_BASELINE.md`, that file wins and
the submission is wrong.

## H. Final pre-submit

- [ ] Re-run `npm run test:all` on the **pushed** commit, not a local one
- [ ] Open the public repository in a logged-out browser and confirm it loads
- [ ] Open the video link in a logged-out browser and confirm it plays
- [ ] Submit

---

## Not done, deliberately

| | |
|---|---|
| ETHGlobal submission created | **No** — explicitly out of scope |
| Any secret published | **No** |
| Final prize claims made | **No** |
| Ledger marked complete | **No** — BLK-002 is open |
