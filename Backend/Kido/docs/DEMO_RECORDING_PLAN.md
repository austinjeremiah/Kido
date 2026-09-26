# Demo recording plan (P10.5)

How to record the submission video so that everything shown is real and everything claimed is
accurate. This plan exists to make dishonesty *inconvenient*, not just discouraged.

## Absolute rules

1. **No re-enactment.** Every terminal frame is a live run against Sepolia. If a run fails, either
   re-run it on camera or keep the failure in.
2. **No mainnet.** Every script asserts `chainId == 11155111`. If any frame shows another chain id,
   the take is void.
3. **Never say** "runs in a TEE", "deployed to CRE", "DON-signed", "Ledger-approved", or "hardware
   approval". Each is false and each is individually disqualifying for honesty.
4. **The stand-in approver must be spoken aloud** the first time the escalation scene appears —
   "stand-in key, not a Ledger device".
5. **No secret on screen, ever.** See the pre-flight checklist below.
6. **The limitations beat is not optional** and is not the last thing said before the cut. It gets
   its own segment with the speaker's full attention.

## Pre-flight (do all of this before recording)

```bash
npm run health          # must print HEALTH: READY
npm run test:all        # must print ALL NON-HARDWARE SUITES PASS
```

Screen hygiene — the failure mode here is a leaked key, and it is irreversible once published:

- [ ] Close every editor, browser tab and terminal not used in the take.
- [ ] Ensure no `.env` file, key file or password manager is open in any window.
- [ ] Clear shell history for the session, or use a fresh shell: a recalled command can contain a
      key from an earlier session.
- [ ] Disable clipboard managers, notification banners, and any AI assistant overlay.
- [ ] Terminal profile with **no** custom prompt that interpolates environment variables.
- [ ] Confirm the relayer holds Sepolia ETH — a mid-take out-of-gas is a wasted run.
- [ ] Confirm the browser is on `localhost:3000` and the console has already loaded (first load
      does live chain reads and is slow).

## Capture setup

| | |
|---|---|
| Resolution | 1920×1080, 30fps minimum |
| Terminal | ≥16pt, high contrast — **the revert reasons are the evidence** and must be legible |
| Layout | Terminal primary; browser console cut in for the architecture and agents tabs |
| Audio | Single take per segment; record room tone for edit points |

## Segment order and expected wall-clock

Live Sepolia scenes take real time. Budget for it rather than cutting mid-transaction.

| # | Segment | Command | Approx. live duration |
|---|---|---|---|
| 1 | Problem statement | — | speak over the architecture tab |
| 2 | ALLOW | `npm run demo:allow` | ~20–30s |
| 3 | DENY | `npm run demo:deny` | ~15–25s |
| 4 | Mutation + replay *(5-min cut only)* | `npm run demo:mutate`, `npm run demo:replay` | ~40s |
| 5 | Private-context proof | `npm run demo:cre-private-context` | ~30–45s |
| 6 | ENS revocation | `npm run demo:ens-revoke` | ~40–60s *(3 transactions)* |
| 7 | Escalation | `npm run demo:escalate:software` | ~40–60s |
| 8 | Deny-list / inexpressibility | console → Agents tab | speak only |
| 9 | Limitations | — | speak only, **mandatory** |

`npm run demo:all` runs 2–7 in one pass with a summary. Prefer individual scenes for the video so
each has a clean start frame; keep one `demo:all` recording as a single-take backup.

## Ordering hazard

The ENS revocation scene changes the name's token id **twice** — revoke, then restore. Running
scenes out of order after a revoke leaves later scenes with a stale identity and they will fail with
`IdentityNotCurrent` for the wrong reason. This was a real bug during development.

**Either** run scenes in the order above, **or** run `npm run demo:all`, which handles the rebind.

## What must appear on screen at least once

- [ ] A Sepolia transaction hash from a successful execution
- [ ] `callCount` unchanged across a blocked scene *(proves nothing executed)*
- [ ] A named revert reason: `CalldataHashMismatch`, `NonceUsed`, `IdentityNotCurrent`,
      `HumanApprovalRequired`, `AuthorizationNotAllow`
- [ ] All four verdicts of the private-context proof, in one frame
- [ ] The README status table, or the console's sponsor-status row: **ENS LIVE · CRE SIMULATOR ·
      LEDGER PENDING HARDWARE**

## The limitations segment — required wording

Deliver in full. Do not compress, and do not place it under the closing music.

> "Being precise about what's real. **ENS is live on Sepolia** and load-bearing — the revocation
> you just saw is real chain state. **Chainlink ran in the official CRE simulator**, triggered by
> real Sepolia events. That is *not* a live DON deployment, and nothing ran in a real TEE.
> **Ledger integration is software-complete and tested, but no physical device was available**, so
> there is no hardware evidence and we are not claiming that prize. None of this is audited."

## Post-recording checks

- [ ] Scrub the full video at 2× and confirm no key, seed phrase, `.env` content, or private RPC
      URL with an embedded API key ever appears — **including in a browser tab title or a shell
      autocomplete suggestion**.
- [ ] Confirm the limitations segment is present, audible, and not truncated.
- [ ] Confirm every transaction hash shown resolves on `sepolia.etherscan.io`.
- [ ] Confirm nothing in the narration contradicts `docs/CRE_MODE_BASELINE.md`. That file is
      authoritative; if the video disagrees, the video is wrong.
- [ ] If a key is exposed in any frame: **do not trim and publish**. Rotate the key first. The raw
      file may already exist elsewhere.

## If BLK-002 closes before recording

If a physical Ledger becomes available:

1. Run `npm run test:ledger:hardware` — it must actually pass, not be skipped.
2. Photograph the device screen rendering the ERC-7730 approval descriptor.
3. Re-record segment 7 with the device in frame, and update the limitations wording to state that
   the approval was device-signed.
4. Update `deployments/sepolia.json` (`ledger.physicalApproval`), `docs/PRIZE_QUALIFICATION.md`,
   and the README status table **before** the video is published, so no artefact disagrees.

Until all four are done, the Ledger claim stays withdrawn everywhere.
