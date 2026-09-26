# Public repository readiness (P10.9)

Checks run before this repository is made public, with real output. A key published to a public
repository is compromised the moment it is pushed — trimming the commit later does not help,
because the object may already be mirrored.

Verified **2026-09-08**.

---

## 1. No secret material is tracked

```
$ git ls-files | grep -iE "\.env$|\.key$|\.pem$|keystore|wallets\.json|\.keyring|WALLET_PASS"
(no matches)
```

The only tracked env files are **examples**:

```
.env.example
workflows/cre-policy/contextlock-cre/.env.example
workflows/cre-policy/contextlock-policy/.env.example
```

Each contains **variable names with empty values only**. Verified by reading all three.

Note one deliberate deviation: the upstream CRE template ships a literal placeholder private key in
its `.env.example` (`0x…0001`, the well-known "private key = 1"). It is **blanked here**. An
example file that contains a key-shaped value trains both humans and secret scanners to treat
64-hex-next-to-`PRIVATE_KEY` as normal, and that is exactly the habit that gets a real key
committed.

## 2. One tracked `secrets.yaml`, and it holds no values

`workflows/cre-policy/contextlock-cre/secrets.yaml` is tracked — the CRE CLI requires it at a fixed
path, so a fresh checkout needs it. It maps secret **ids** to environment **variable names**:

```yaml
secretsNames:
    CONTEXTLOCK_PRIVATE_POLICY:
        - SECRET_CONTEXTLOCK_PRIVATE_POLICY
    CONTEXTLOCK_RISK_API_TOKEN:
        - SECRET_CONTEXTLOCK_RISK_API_TOKEN
```

The blanket `secrets.yaml` gitignore remains in force everywhere else, and `scripts/secret-scan.sh`
separately asserts this file contains no assigned values.

## 3. Secret scan — working tree **and history**

```
$ npm run secret-scan
OK  no secret files in history
SECRET SCAN: CLEAN
```

History is scanned, not just the checkout. A key removed in a later commit is still published.

## 4. Confidential canary scan

```
$ npm run canary-scan
CONF-001: PASS - no confidential value crossed the boundary
```

Five surfaces: tracked files, git history, build and deployment artifacts, local databases and
logs, and the workflow's own stdout/stderr during execution.

The demo private-policy values (canary included) exist **only** in two test fixtures under
`workflows/cre-policy/contextlock-policy/`, and the scanner enforces that boundary — a non-test
file in that same directory fails, which is verified explicitly.

Stated honestly, as the script itself does: in a live CRE deployment the private policy is released
by the Vault DON into the attested enclave and **must not be in the repository at all**. These are
demo values, and the canary exists precisely so that a leak of them anywhere else is detected.

## 5. Privilege audit

```
$ npm run privilege-audit
PRIVILEGE AUDIT: CLEAN
```

Includes the rule added in Phase 9: `apps/web/` — browser-served code — may **name** a privileged
variable in prose but may **read no environment variable at all**.

## 6. No key-shaped strings outside expected places

A repository-wide scan for 64-hex sequences returns only ABI-encoded constructor arguments inside
ENS deployment artifacts (`packages/ens/deployments/*.json`) — public on-chain data, not secrets.

## 7. Keys used during the build

All testnet, all disposable. Their **addresses** appear in `deployments/sepolia.json`; no private
key appears anywhere in the repository or its history.

| Role | Note |
|---|---|
| Funder | **Funder only** — holds no protocol role, by explicit constraint |
| Deployer / policy admin | disposable Sepolia key |
| Capability issuer | disposable Sepolia key, hot by design |
| Relayer | disposable Sepolia key |
| Agent | holds no key at all — it is the untrusted party |
| Approver | `STAND-IN — NOT LEDGER-HELD` (BLK-002) |

The author has stated these testnet keys will be rotated. No mainnet key, personal wallet, or
Ledger seed material was ever present.

## 8. Git history is publishable

- Unsquashed, one commit per coherent unit of work, each carrying its test evidence.
- No commit message contains a secret or a key.
- No force-push rewrote away a finding. History was rewritten exactly once, early, to remove phase
  numbers from two commit subjects at the author's request — no content changed.

## 9. License and attribution present

- `LICENSE` — MIT, with an explicit unaudited/testnet-only note.
- `AI_USAGE.md` — full AI attribution, including where AI judgment was overridden.
- `docs/SOURCE_PROVENANCE.md` — original vs. third-party code.

## 10. Documentation states limitations before capabilities

The README's **first** table names the CRE simulator and the absent Ledger hardware. A reader who
discovers a limitation after being impressed discounts everything that came before it.

---

## Before pushing public — final checklist

- [ ] `npm run test:all` → `ALL NON-HARDWARE SUITES PASS`
- [ ] `git ls-files` shows no `.env`, key, or keystore file
- [ ] `git log -p` spot-checked for accidentally committed values
- [ ] `deployments/sepolia.json` contains addresses and hashes only
- [ ] Rotate the testnet keys used during the build **regardless** of the scans passing
- [ ] Confirm no RPC URL with an embedded provider API key is tracked (it is in `.env` only)
