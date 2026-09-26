# Contract verification plan (P10.11)

How to verify the ContextLock contracts on Sepolia Etherscan, and — more importantly — how to check
that the deployed bytecode matches this source **without** trusting Etherscan or this document.

**Current status: source verification on Etherscan is NOT yet published.** What exists today is
local bytecode confirmation, recorded in `reports/phase-03/evidence/p3-bytecode-verification.txt`
and `reports/phase-07/evidence/p7-bytecode.txt`. Stated plainly rather than implied.

---

## Exact compiler settings

Verification fails on any mismatch, so these must be reproduced exactly. From
`contracts/foundry.toml`:

| Setting | Value |
|---|---|
| `solc` | `0.8.28` |
| `evm_version` | `cancun` |
| `optimizer` | `true` |
| `optimizer_runs` | `200` |
| `via_ir` | **`true`** |
| `bytecode_hash` | `none` |

Two of these matter more than the rest:

- **`via_ir = true`** — required because the 15-field capability struct triggers stack-too-deep. The
  IR pipeline produces different bytecode from the legacy pipeline; verification against a
  non-IR build will fail even with identical source.
- **`bytecode_hash = "none"`** — no metadata hash is appended, so builds are reproducible across
  machines and paths. Etherscan must be told this, or the trailing-bytes comparison fails.

The same values are recorded in `deployments/sepolia.json` under `compiler`, so a verifier does not
have to read the Foundry config to find them.

## Addresses to verify

| Contract | Address |
|---|---|
| ContextLockExecutor (canonical, v2) | `0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23` |
| ContextLockApprovalRegistry | `0xD6E420734667382e49091072e9824902d6c93574` |
| ContextLockCreConsumer | `0x0eAA86cDA5622A8384c3eC9F47aD129902A8123F` |
| ContextLockGateway | `0xA2cD6003b092a4F4a69b86e75b60dcDD7737d9Bb` |
| ContextLockPolicyRegistry | `0xCBd976E8BBbA70867d581A35e5a5CF1C2ed47F24` |
| ContextLockAuthorizationRegistry | `0xFAD71bbcCfFdFbFA8B500bc9b8FF6F0C7F9De8e3` |
| EnsAgentIdentityVerifier | `0xbD44B9A7491A3168F772Ca96433c17a0B18a6149` |
| MockTreasuryTarget | `0xf20B833b26b981F8A2211473f46cf457430CE153` |

`0xe109686a0a10b0FC8f090F2bBd1424C50fE2920a` is the **superseded** v1 executor. It is retained in
the manifest because Phase 3–6 evidence references it, and it should be verified too if the earlier
evidence is being checked — but it is not the contract in use.

## Publishing verification

Requires an Etherscan API key (`ETHERSCAN_API_KEY`), which is why this is documented as a plan
rather than presented as done.

```bash
cd contracts

forge verify-contract \
  --chain-id 11155111 \
  --num-of-optimizations 200 \
  --compiler-version 0.8.28 \
  --via-ir \
  --constructor-args $(cast abi-encode "constructor(<types>)" <args>) \
  0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23 \
  src/ContextLockExecutor.sol:ContextLockExecutor \
  --etherscan-api-key "$ETHERSCAN_API_KEY"
```

Constructor arguments per contract are recoverable from the deployment transactions referenced in
`deployments/sepolia.json` and from `contracts/script/DeploySepolia.s.sol` /
`contracts/script/DeployP7.s.sol`.

Repeat for each address above. Verify the **canonical executor first** — it is the reference monitor
and the only contract whose correctness the whole design depends on.

## Verifying without trusting Etherscan (recommended)

Etherscan verification is a convenience. The check that actually matters is comparing deployed
runtime bytecode against a local build:

```bash
cd contracts && forge build

# deployed runtime bytecode
cast code 0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23 --rpc-url "$SEPOLIA_RPC_URL" > /tmp/onchain.hex

# locally compiled runtime bytecode
jq -r '.deployedBytecode.object' out/ContextLockExecutor.sol/ContextLockExecutor.json > /tmp/local.hex

diff <(tr -d '\n' < /tmp/onchain.hex) <(tr -d '\n' < /tmp/local.hex) && echo "MATCH"
```

`bytecode_hash = "none"` is what makes this a clean comparison — with metadata appended, the tail
bytes differ by build path and the diff is noise.

Note the limits of what a match proves: immutable constructor values are baked into runtime
bytecode, so a match confirms **both** the source and those immutables. A pure `diff` on a contract
with immutables will only match if you build with the same constructor arguments.

## Independent checks that need no build at all

```bash
npm run health
```

Reads live Sepolia and asserts the deployment is internally consistent: chain id 11155111, the
executor points at the registries in the manifest, the CRE writer **is** the consumer contract, the
ENS identity is current, and the approval registry's executor is the canonical executor.

Spot checks with `cast`:

```bash
# the authorization writer must be the consumer contract, not an EOA
cast call 0xFAD71bbcCfFdFbFA8B500bc9b8FF6F0C7F9De8e3 "authorizer()(address)" --rpc-url "$SEPOLIA_RPC_URL"
# expect 0x0eAA86cDA5622A8384c3eC9F47aD129902A8123F

# the approval registry may only be consumed by the canonical executor
cast call 0xD6E420734667382e49091072e9824902d6c93574 "executor()(address)" --rpc-url "$SEPOLIA_RPC_URL"
# expect 0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23
```

If either disagrees with `deployments/sepolia.json`, the manifest is wrong and should not be
trusted — file it rather than working around it.

## Current evidence

| | |
|---|---|
| Codesize confirmation (Phase 7) | `reports/phase-07/evidence/p7-bytecode.txt` — approval registry 2283, executor v2 5891 |
| Bytecode verification (Phase 3) | `reports/phase-03/evidence/p3-bytecode-verification.txt` |
| Deployment transcripts | `reports/phase-03/evidence/p3-sepolia-deploy.txt`, `reports/phase-07/evidence/p7-sepolia-deploy.txt` |
| Live consistency check | `npm run health` → **HEALTH: READY** |

## Honest note

Etherscan source verification is genuinely useful for a reviewer who will not clone the repository,
and it is not done. It is a missing convenience, not a missing security property — the bytecode
comparison above is strictly stronger, because it does not require trusting a third party's claim
about what source produced what bytecode.
