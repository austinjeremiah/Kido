# Chainlink Runtime Environment (CRE) — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **Workflow** = trigger(s) + handler callback, compiled to **WASM** (TS runs via Javy/QuickJS) and executed by a Workflow DON. Node APIs (`fetch`, `setTimeout`, `crypto`, `fs`, …) are not available; the SDK types mark them `@deprecated`. verified(live) `cre-sdk@1.22.0 dist/sdk/types/restricted-apis.d.ts`.
- **Capabilities**, each run by its own DON: Cron trigger, HTTP trigger, EVM Log trigger, HTTP client, EVM client (read / `writeReport`), Confidential HTTP client, Solana client/write. verified(docs) https://docs.chain.link/cre/capabilities; verified(live) `cre` namespace in `dist/sdk/cre/index.d.ts` exports `CronCapability, HTTPCapability, ConfidentialHTTPClient, HTTPClient, EVMClient, SolanaClient`.
- **Consensus**: BFT consensus is built into every capability call. `runtime.runInNodeMode(fn, consensusAggregation)` runs per-node code and aggregates the results (median, identical, etc.). verified(docs) consensus-computing; verified(live) `Runtime.runInNodeMode` signature in `dist/sdk/runtime.d.ts`.
- **In simulation, consensus is single-node.** "consensus uses a single-node model … involves a single node wrapping its result in a standardized report structure". verified(docs) consensus-computing.
- **DON time**: use `runtime.now()`. "Do not use `Date.now()` … in DON Mode — they introduce non-determinism." verified(docs) time-in-workflows.
- **Reports**: `runtime.report({encodedPayload (base64), encoderName:'evm', signingAlgo:'ecdsa', hashingAlgo:'keccak256'})` produces a DON-signed report. You then deliver it with `evmClient.writeReport(runtime, {receiver, report, …})`, and the KeystoneForwarder calls `receiver.onReport(metadata, report)`. verified(docs) making-workflow-confidential (step 4, links to writeReport); verified(live) forwarder source.
- **Confidential Workflows**: `handlerInTee(trigger, fn, teeConstraint)`. The callback gets a `TeeRuntime` (`getSecret(s)`, `now`, `log`, `reportFromDon`, `usingTheDons()`). Anything passed to `usingTheDons()` leaves the enclave and is no longer confidential. Triggers and chain reads/writes always run on Workflow DON nodes, never inside the enclave. The only registered TEE is AWS Nitro in `us-west-2` (`REGIONS = NITRO_REGIONS = ['us-west-2']`). verified(docs) confidential-workflows; verified(live) `dist/sdk/runtime.d.ts`, `dist/sdk/tee-constraints.js`.
- **Confidential HTTP** (`ConfidentialHTTPClient`): consensus runs on the request parameters, and one request is executed from an enclave. Secrets are referenced as `{{.key}}` templates via `vaultDonSecrets`, and the response can be AES-GCM encrypted (`EncryptOutput`). It does **not** make the rest of the workflow confidential, and there is no data transformation inside the enclave. Inside a `TeeRuntime`, use the `HTTPClient.sendRequest(teeRuntime, …)` overload, not `ConfidentialHTTPClient`. verified(docs) confidential-http, making-workflow-confidential ("Use the TeeRuntime overload, not ConfidentialHTTPClient").
- **Registries** (control plane): `deployment-registry` in `workflow.yaml` is either `"private"` (Chainlink-hosted, authorized by CRE login, no gas, no mainnet RPC) or `"onchain:ethereum-mainnet"`, which is the Workflow Registry on **Ethereum Mainnet**, authorized by a linked wallet and paid in mainnet gas. **When the field is omitted, the CLI defaults to the onchain mainnet registry.** verified(docs) project-configuration ("When omitted, the CLI defaults to the public onchain Workflow Registry"), deploying-workflows.

## Supported operations Kido would use

1. EVM Log trigger on `ContextLockGateway.CapabilityRequested` (`evm.logTrigger(logTriggerConfig({addresses, topics}))`). verified(live): it compiles against 1.22.0.
2. `handlerInTee` + `TeeRuntime.getSecret` for the private policy. Private beta: only simulation is possible today.
3. HTTP GET for risk context from inside the enclave (`HTTPClient.sendRequest(teeRuntime, …)`).
4. `usingTheDons().report(...)` followed by `evmClient.writeReport(donRuntime, { receiver: consumerAddress, report })` for the onchain write on Sepolia. **Kido does not currently do the writeReport step** (§14).
5. Local `cre workflow simulate` with `--non-interactive --trigger-index N --evm-tx-hash … --evm-event-index …` (and `--broadcast` for a real Sepolia tx through the MockKeystoneForwarder). verified(live): all of these flags exist in `cre workflow simulate --help` on v1.32.0.

## Required fields

- `project.yaml`: per-target `rpcs: [{chain-name, url}]`. verified(live) ContextLock file; verified(docs) project-configuration.
- `workflow.yaml`: per-target `user-workflow.workflow-name` (required), `user-workflow.deployment-registry` (optional, **default onchain mainnet**), and `workflow-artifacts.{workflow-path (req), config-path (req), secrets-path (opt)}`. verified(docs) project-configuration.
- `secrets.yaml`: `secretsNames: { ID: [ENV_VAR] }`. In simulation, values come from `.env` or the environment. When deployed, they come from Vault DON via `cre secrets create/update/delete/list`. Production supports **only** the linked-workflow-owner authorization model for `cre secrets`. verified(docs) secrets index.
- Report for EVM: `encoderName 'evm'`, `signingAlgo 'ecdsa'`, `hashingAlgo 'keccak256'`, base64 payload (`hexToBase64`). verified(live) ContextLock code compiles; verified(docs).
- Receiver contract: must implement `IReceiver.onReport(bytes metadata, bytes report)` **and** ERC-165 `supportsInterface` returning true for `type(IReceiver).interfaceId`. verified(live) KeystoneForwarder.sol L148 `if (!ERC165Checker.supportsInterface(receiver, type(IReceiver).interfaceId))` → state `INVALID_RECEIVER` (L192); payload `abi.encodeCall(IReceiver.onReport, (metadata, validatedReport))` (L154).

## Upgrade / version behaviour

- New networks gate on minimum CLI/SDK versions (Hoodi needs CLI 1.35 / TS 1.22). Docs say "Run `cre update`". verified(docs) supported-networks.
- The CLI ships weekly (v1.28 → v1.35 between 07-30 and 09-17). Recent notes include "bump common and v2 to support new aggregator in simulation" (#554), deployment-registry selection in `cre init` (#414), and a reverted "Fail closed on OAuth state in secrets callback" (#559). verified(live) release bodies.
- SDK 1.18.0 → 1.22.0 had no breaking type change for ContextLock's surface: the same `workflow.ts` typechecks on 1.18.0, 1.19.1 and 1.22.0, and `cre workflow build` compiles it to WASM on 1.22.0 (binary hash `6cb458ae…0239`). verified(live) scratch `cre-1.18.0/`, `cre-1.19.1/`, `cre-1.22.0/`, `proj/`.
- The `cre.*` namespace (`cre.handlerInTee`, `cre.capabilities.HTTPClient`) still exists in 1.22.0. Current docs, however, use top-level named imports (`handlerInTee`, `HTTPClient`, `CronCapability`). verified(live) `dist/sdk/cre/index.d.ts`; verified(docs).
- The KeystoneForwarder is at 1.0.0, and the receiver-side interface (IReceiver + ERC-165) is stable in source. verified(live).

## Failure modes

- `cre login` / token refresh fails, which blocks simulate, deploy and `supported-chains`. **Observed today**: `cre whoami` → "credential validation failed … token refresh failed: auth response: 500 Internal Server Error". verified(live). Simulation also needs login ("You must have a CRE account and be logged in with the CLI"). verified(docs) simulating-workflows.
- No deploy access: `cre workflow deploy` prompts for an access request. verified(docs).
- Confidential handler with no private-beta enrolment: it can only be simulated. verified(docs).
- Receiver lacks ERC-165 or has the wrong `onReport` signature: the forwarder marks the transmission `INVALID_RECEIVER`. The forwarder tx does not revert, so the write silently does not land. verified(live) source; the non-revert behaviour is inferred from the state-recording code path.
- Receiver reverts: state `FAILED`. The transmission is recorded per `(receiver, workflowExecutionId, reportId)`. inferred from source.
- `Date.now()` in DON-mode code gives nodes different values, so consensus fails or diverges. verified(docs) time-in-workflows.
- Simulation limits are enforced by default (timeouts, HTTP call counts). Override with `--limits`. verified(docs) understanding-limits; verified(live) flag.
- Omitting `deployment-registry` makes deploy try the mainnet onchain registry, which needs a linked key, mainnet gas and a mainnet RPC. inferred from docs default.

## Limitations

- Deploy is gated (early access). Confidential Workflows is invite-only private beta. The only TEE is Nitro us-west-2. verified(docs/live).
- The onchain Workflow Registry exists only on Ethereum Mainnet. verified(docs).
- TS runs as WASM via Javy: no Node APIs, no `fetch`, no timers. Bun is required (engines bun >=1.2.21). verified(live).
- Confidential HTTP: no data transformation inside the enclave. verified(docs).
- Forwarder addresses and chains vary by tenant. verified(docs).

## Common mistakes

1. Implementing `onReport(bytes)` instead of `onReport(bytes metadata, bytes report)`, and omitting ERC-165. **Kido/ContextLock do both** (D-3).
2. Generating a report but never calling `evmClient.writeReport`. **Kido/ContextLock do this** (D-2).
3. `Date.now()` instead of `runtime.now()`. **Kido/ContextLock do this** (D-4).
4. Leaving the MockKeystoneForwarder address in a production consumer, or the reverse. verified(docs) forwarder directory warning.
5. Omitting `deployment-registry`, which silently targets the mainnet registry. **Kido/ContextLock omit it** (D-5).
6. Treating simulation output as evidence of TEE or DON security. verified(docs).
7. Setting the forwarder to `address(0)` in ReceiverTemplate, which makes the contract insecure. verified(docs).
8. Pinning zod 4 in a CRE workflow. The SDK pins zod 3.25.76 exactly. inferred risk.
