import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { ADAPTER_MANIFEST_VERSION, type ContextLockAdapterManifest } from "../../core/manifest.js";
import type {
  AdapterExecutionContext,
  AdapterSimulationFixture,
  ExecutionAdapter,
  ExecutionConstraints,
  NormalizedAction,
  ValidationProblem,
  ValidationResult,
} from "../../core/contracts.js";
import { ccipDeploymentFor, chainIdForSelector, laneIsVerified, CCIP_DEPLOYMENTS } from "./deployments.js";

/**
 * Chainlink CCIP, as a CROSS_CHAIN adapter under the generic kernel.
 *
 * The kernel already declared `CROSS_CHAIN` as an adapter type in P12 and left it unimplemented.
 * Nothing in the kernel changed to accommodate this — a cross-chain send is an execution that
 * happens to name a second chain, and it is validated the same way every other execution is:
 * decode the calldata, compare the decoded fields against the intent and the Blueprint's
 * constraints, and refuse on any disagreement.
 *
 * What is different is what a "successful" send means. `ccipSend` returning a message id is not the
 * action completing; it is the action being handed to a protocol that will finish it later, on
 * another chain, or not at all. The adapter says so in its expected effects and never claims more.
 */

export const CCIP_ROUTER_ABI = parseAbi([
  "struct EVMTokenAmount { address token; uint256 amount; }",
  "struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }",
  "function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)",
  "function getFee(uint64 destinationChainSelector, EVM2AnyMessage message) view returns (uint256)",
  "function isChainSupported(uint64 destChainSelector) view returns (bool)",
]);

export class CcipError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CcipError";
  }
}

export type CcipActionKind = "CROSS_CHAIN_TOKEN_TRANSFER" | "CROSS_CHAIN_MESSAGE" | "PROGRAMMABLE_TRANSFER";

export interface CcipIntent {
  action: CcipActionKind;
  sourceChainId: number;
  destinationChainId: number;
  /** The party that will receive on the destination chain. */
  receiver: string;
  tokenTransfers: Array<{ token: string; amount: string }>;
  /** Arbitrary payload. Carries plan binding, never authority — see receiver security below. */
  data: `0x${string}`;
  /** Address of the fee token, or the zero address for native. */
  feeToken: string;
  gasLimit: number;
  timeoutMs: number;
}

export interface CcipPrepared {
  to: string;
  data: string;
  value: string;
  chainId: number;
  /** What the builder CLAIMS. Present because a real integration has it; never read by decode. */
  summary: { action: string; destination: string; receiver: string; amount: string };
}

export interface CcipConstraints extends ExecutionConstraints {
  /** Destination chains the Blueprint permits. Absent means refused, whatever the lane supports. */
  permittedDestinationChainIds: number[];
  /** Actions the Blueprint permits. PROGRAMMABLE_TRANSFER is high risk and off by default. */
  permittedActions: CcipActionKind[];
  /** Receivers the Blueprint permits on the destination chain. */
  allowedDestinationReceivers: string[];
}

/**
 * Actions that let the message trigger a call on the destination.
 *
 * A programmable transfer carries a payload the destination receiver will act on. That is exactly
 * the shape P19.8 warns about — a message becoming call authority — so it is refused unless the
 * Blueprint names it, in the same way Aave refuses WITHDRAW unless named.
 */
export const CCIP_HIGH_RISK_ACTIONS = new Set<CcipActionKind>(["PROGRAMMABLE_TRANSFER"]);

const manifest: ContextLockAdapterManifest = {
  schemaVersion: ADAPTER_MANIFEST_VERSION,
  id: "chainlink-ccip",
  version: "1.0.0",
  adapterType: "CROSS_CHAIN",
  name: "Chainlink CCIP",
  description:
    "Constructs and independently validates CCIP cross-chain sends on verified testnet lanes. A send is not an arrival; completion is proven separately on the destination chain.",
  provider: "chainlink",
  supportedChains: Object.keys(CCIP_DEPLOYMENTS).map(Number),
  capabilities: [
    { name: "CROSS_CHAIN_TOKEN_TRANSFER", description: "Move a supported token to a verified destination chain." },
    { name: "CROSS_CHAIN_MESSAGE", description: "Send a data-only message to a destination receiver." },
    {
      name: "PROGRAMMABLE_TRANSFER",
      description: "Token transfer carrying a payload the receiver acts on. HIGH RISK — never permitted by default.",
    },
  ],
  inputSchema: {},
  outputSchema: {},
  trustClass: "USER_UNTRUSTED",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
  permissionsRequired: [],
  executionPlacement: "studio-backend",
  safety: {
    decodesPreparedTransactions: true,
    supportsDryRun: true,
    allowsArbitraryTarget: false,
    allowsArbitraryRecipient: false,
    independentlyValidatesProviderOutput: true,
  },
  generatedModules: [
    { path: "src/adapters/chainlink-ccip/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/chainlink-ccip/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: [
    "XCHAIN-NORMAL",
    "XCHAIN-WRONG-DESTINATION",
    "XCHAIN-WRONG-RECEIVER",
    "XCHAIN-AMOUNT-MUTATION",
    "XCHAIN-UNVERIFIED-LANE",
    "XCHAIN-PROGRAMMABLE-FORBIDDEN",
    "XCHAIN-MAINNET-REFUSED",
  ],
  securityAssertions: [
    { id: "AS-CCIP-1", statement: "A substituted destination receiver is rejected on the decoded calldata, not on the builder's summary.", provenBy: ["PLAN-010"] },
    { id: "AS-CCIP-2", statement: "A chain selector is compared as a string; no uint64 is narrowed to a JS number.", provenBy: ["PLAN-009"] },
    { id: "AS-CCIP-3", statement: "Adapter capability is not agent authority: programmable transfers are refused unless the Blueprint names them.", provenBy: ["PLAN-017"] },
    { id: "AS-CCIP-4", statement: "Mainnet chain ids are refused by the adapter regardless of configuration.", provenBy: ["PLAN-020"] },
  ],
  documentation: {
    officialDocs: ["https://docs.chain.link/ccip", "https://docs.chain.link/ccip/directory/testnet"],
    verifiedOn: "2026-09-08",
    notes:
      "Routers verified on chain via typeAndVersion() (both 'Router 1.2.0') and lanes via isChainSupported() in both directions. Selectors from smartcontractkit/chain-selectors. Ethereum Sepolia 11155111 -> 16015286601757825753; Base Sepolia 84532 -> 10344971235874465080.",
  },
};

/** Chain ids this adapter refuses outright, whatever a Blueprint or a model asks for. */
const MAINNET_CHAIN_IDS = new Set([1, 8453, 42161, 10, 137, 43114, 56]);

export class ChainlinkCcipAdapter implements ExecutionAdapter<CcipIntent, CcipPrepared> {
  constructor(private readonly builder?: (i: CcipIntent) => CcipPrepared) {}

  manifest(): ContextLockAdapterManifest {
    return manifest;
  }

  supportedActions(): string[] {
    return ["CROSS_CHAIN_TOKEN_TRANSFER", "CROSS_CHAIN_MESSAGE", "PROGRAMMABLE_TRANSFER"];
  }

  normalizeIntent(intent: unknown) {
    const i = intent as CcipIntent;
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string) =>
      problems.push({ code, severity: "CRITICAL", field, message });

    const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

    if (!this.supportedActions().includes(i?.action)) P("CCIP-I-ACTION", "action", `unsupported action ${String(i?.action)}`);

    for (const [field, id] of [["sourceChainId", i?.sourceChainId], ["destinationChainId", i?.destinationChainId]] as const) {
      if (typeof id !== "number") { P("CCIP-I-CHAIN", field, `${field} must be a number`); continue; }
      if (MAINNET_CHAIN_IDS.has(id)) {
        // Refused here rather than in configuration: a mainnet send must be impossible to reach by
        // any path, including one a future caller adds without reading this file.
        P("CCIP-I-MAINNET", field, `chain ${id} is mainnet; this build is testnet-only`);
      }
    }
    if (typeof i?.sourceChainId === "number" && typeof i?.destinationChainId === "number") {
      if (i.sourceChainId === i.destinationChainId) P("CCIP-I-SAME-CHAIN", "destinationChainId", "source and destination are the same chain");
      else if (!laneIsVerified(i.sourceChainId, i.destinationChainId)) {
        P("CCIP-I-UNVERIFIED-LANE", "destinationChainId", `lane ${i.sourceChainId} -> ${i.destinationChainId} was not verified on chain in this build`);
      }
    }
    if (!addr(i?.receiver)) P("CCIP-I-RECEIVER", "receiver", "receiver must be a 20-byte address");
    if (!Array.isArray(i?.tokenTransfers)) P("CCIP-I-TOKENS", "tokenTransfers", "tokenTransfers must be an array");
    else {
      for (const [n, t] of i.tokenTransfers.entries()) {
        if (!addr(t?.token)) P("CCIP-I-TOKEN", `tokenTransfers[${n}].token`, "token must be an address");
        if (!/^\d+$/.test(String(t?.amount)) || BigInt(t?.amount ?? "0") === 0n) {
          P("CCIP-I-AMOUNT", `tokenTransfers[${n}].amount`, "amount must be a positive integer in base units");
        }
      }
    }
    if (i?.action === "CROSS_CHAIN_TOKEN_TRANSFER" && i.data !== "0x") {
      P("CCIP-I-UNEXPECTED-DATA", "data", "a plain token transfer must not carry a payload; use PROGRAMMABLE_TRANSFER and declare it");
    }
    if (typeof i?.timeoutMs !== "number" || i.timeoutMs <= 0) P("CCIP-I-TIMEOUT", "timeoutMs", "a cross-chain step must state a timeout");

    return problems.length === 0 ? { ok: true as const, intent: i } : { ok: false as const, problems };
  }

  async buildTransaction(intent: CcipIntent, _ctx: AdapterExecutionContext): Promise<CcipPrepared> {
    if (!this.builder) throw new CcipError("CCIP-NO-BUILDER", "no transaction builder configured");
    return this.builder(intent);
  }

  /**
   * Re-derive everything from calldata.
   *
   * The destination selector, the receiver, the tokens and the amounts all come out of the encoded
   * `ccipSend` arguments. `prepared.summary` is never consulted — a builder that wanted to mislead
   * would produce an honest-looking summary beside a hostile message, and every fixture in the test
   * suite does exactly that to prove the summary is not load-bearing.
   */
  async decodeTransaction(prepared: CcipPrepared): Promise<NormalizedAction> {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: CCIP_ROUTER_ABI, data: prepared.data as `0x${string}` });
    } catch (e) {
      throw new CcipError("CCIP-NOT-ROUTER-CALL", `calldata is not a CCIP Router call: ${(e as Error).message}`);
    }
    if (decoded.functionName !== "ccipSend") {
      throw new CcipError("CCIP-UNSUPPORTED-FUNCTION", `Router function "${decoded.functionName}" is not decoded by this adapter`);
    }

    const [selector, message] = decoded.args as [bigint, { receiver: `0x${string}`; data: `0x${string}`; tokenAmounts: readonly { token: `0x${string}`; amount: bigint }[]; feeToken: `0x${string}`; extraArgs: `0x${string}` }];

    // The selector is a uint64. It is carried onward as a decimal STRING and never as a number.
    const selectorStr = selector.toString();
    const destinationChainId = chainIdForSelector(selectorStr);

    // `receiver` is abi.encode(address) — 32 bytes with the address in the low 20.
    const receiverHex = message.receiver.length >= 66 ? `0x${message.receiver.slice(-40)}` : message.receiver;

    const outputs = message.tokenAmounts.map((t) => ({
      token: getAddress(t.token),
      amount: t.amount.toString(),
      to: /^0x[0-9a-fA-F]{40}$/.test(receiverHex) ? getAddress(receiverHex as `0x${string}`) : receiverHex,
    }));

    return {
      chainId: prepared.chainId,
      target: getAddress(prepared.to),
      calldata: prepared.data,
      value: prepared.value,
      // A cross-chain send moves value OUT of the source chain, so it is an output with a
      // recipient — which is what makes the generic recipient check apply to it unchanged.
      actionType: message.data === "0x" ? "CROSS_CHAIN_TOKEN_TRANSFER" : "PROGRAMMABLE_TRANSFER",
      inputs: [],
      outputs,
      recipient: /^0x[0-9a-fA-F]{40}$/.test(receiverHex) ? getAddress(receiverHex as `0x${string}`) : receiverHex,
      allowanceChanges: [],
      minOutputs: [],
      providerMetadata: {
        function: decoded.functionName,
        summary: prepared.summary,
        destinationChainSelector: selectorStr,
        destinationChainId: destinationChainId === null ? "UNKNOWN" : String(destinationChainId),
        payloadBytes: String((message.data.length - 2) / 2),
        feeToken: getAddress(message.feeToken),
      },
    };
  }

  validateTransaction(n: NormalizedAction, intent: CcipIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string, severity: ValidationProblem["severity"] = "CRITICAL") =>
      problems.push({ code, severity, field, message });
    const cc = c as CcipConstraints;
    const permittedActions = cc.permittedActions ?? ["CROSS_CHAIN_TOKEN_TRANSFER"];
    const meta = n.providerMetadata as Record<string, string>;

    if (n.chainId !== c.chainId) P("CCIP-V-CHAIN", "chainId", `transaction is for chain ${n.chainId}, constraints are for ${c.chainId}`);

    const expectedRouter = (() => {
      try { return ccipDeploymentFor(c.chainId).router.toLowerCase(); } catch { return null; }
    })();
    if (!expectedRouter) P("CCIP-V-NO-DEPLOYMENT", "target", `chain ${c.chainId} has no verified CCIP deployment`);
    else if (n.target.toLowerCase() !== expectedRouter) {
      P("CCIP-V-ROUTER", "target", `target ${n.target} is not the verified CCIP Router ${expectedRouter} for chain ${c.chainId}`);
    }

    if (!permittedActions.includes(n.actionType as CcipActionKind)) {
      P("CCIP-V-ACTION-NOT-PERMITTED", "actionType", `decoded action ${n.actionType} is not permitted by the Blueprint (permitted: ${permittedActions.join(", ") || "none"})`);
    }
    if (n.actionType !== intent.action) {
      P("CCIP-V-ACTION-MISMATCH", "actionType", `decoded ${n.actionType} but the intent asked for ${intent.action}`);
    }

    // Destination, compared as a string. This is the check that a numeric comparison would lose.
    const expectedSelector = (() => {
      try { return ccipDeploymentFor(intent.destinationChainId).chainSelector; } catch { return null; }
    })();
    if (!expectedSelector) P("CCIP-V-UNKNOWN-DESTINATION", "destinationChainSelector", `no verified deployment for destination chain ${intent.destinationChainId}`);
    else if (meta.destinationChainSelector !== expectedSelector) {
      P("CCIP-V-DESTINATION", "destinationChainSelector", `decoded selector ${meta.destinationChainSelector} is not ${expectedSelector} (chain ${intent.destinationChainId})`);
    }
    if (meta.destinationChainId === "UNKNOWN") {
      P("CCIP-V-UNKNOWN-SELECTOR", "destinationChainSelector", `decoded selector ${meta.destinationChainSelector} matches no chain this build has verified`);
    } else if (Array.isArray(cc.permittedDestinationChainIds) && !cc.permittedDestinationChainIds.includes(Number(meta.destinationChainId))) {
      P("CCIP-V-DESTINATION-NOT-PERMITTED", "destinationChainId", `destination chain ${meta.destinationChainId} is not permitted by the Blueprint`);
    }

    // Receiver. Checked against the Blueprint's allow-list AND the intent, because a receiver that
    // is on the allow-list but is not the one this step intended is still the wrong receiver.
    const receiver = String(n.recipient ?? "");
    const allowed = (cc.allowedDestinationReceivers ?? []).map((a) => a.toLowerCase());
    if (allowed.length > 0 && !allowed.includes(receiver.toLowerCase())) {
      P("CCIP-V-RECEIVER-NOT-ALLOWED", "receiver", `decoded receiver ${receiver} is not in the Blueprint's destination allow-list`);
    }
    if (receiver.toLowerCase() !== intent.receiver.toLowerCase()) {
      P("CCIP-V-RECEIVER", "receiver", `decoded receiver ${receiver} does not match the intended ${intent.receiver}`);
    }

    // Tokens and amounts, decoded vs intended.
    if (n.outputs.length !== intent.tokenTransfers.length) {
      P("CCIP-V-TRANSFER-COUNT", "tokenAmounts", `decoded ${n.outputs.length} transfer(s), intent declared ${intent.tokenTransfers.length}`);
    } else {
      for (const [i, out] of n.outputs.entries()) {
        const want = intent.tokenTransfers[i]!;
        if (out.token.toLowerCase() !== want.token.toLowerCase()) {
          P("CCIP-V-TOKEN", `tokenAmounts[${i}].token`, `decoded token ${out.token} does not match the intended ${want.token}`);
        }
        if (out.amount !== want.amount) {
          P("CCIP-V-AMOUNT", `tokenAmounts[${i}].amount`, `decoded amount ${out.amount} does not match the intended ${want.amount}`);
        }
      }
    }

    if (CCIP_HIGH_RISK_ACTIONS.has(n.actionType as CcipActionKind) && !permittedActions.includes(n.actionType as CcipActionKind)) {
      P("CCIP-V-PROGRAMMABLE-FORBIDDEN", "data", "the message carries a payload the destination would act on, and programmable transfers are not permitted");
    }

    return { ok: problems.length === 0, problems };
  }

  fixtureQuery(): unknown {
    return { action: "CROSS_CHAIN_TOKEN_TRANSFER", sourceChainId: 11155111, destinationChainId: 84532 };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    return [];
  }

  generateTemplateConfig(): Record<string, unknown> {
    return {
      routers: Object.fromEntries(Object.entries(CCIP_DEPLOYMENTS).map(([id, d]) => [id, { router: d.router, chainSelector: d.chainSelector }])),
      verifiedLanes: VERIFIED_LANES_EXPORT,
    };
  }
}

const VERIFIED_LANES_EXPORT = [
  { sourceChainId: 11155111, destinationChainId: 84532 },
  { sourceChainId: 84532, destinationChainId: 11155111 },
];

export const ccipManifest = manifest;
