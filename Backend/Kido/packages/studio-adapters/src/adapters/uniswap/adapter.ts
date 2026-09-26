import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, getAddress } from "viem";
import { ADAPTER_MANIFEST_VERSION, type ContextLockAdapterManifest } from "../../core/manifest.js";
import {
  invalid,
  valid,
  type AdapterExecutionContext,
  type AdapterSimulationFixture,
  type ExecutionAdapter,
  type ExecutionConstraints,
  type NormalizedAction,
  type ValidationProblem,
  type ValidationResult,
} from "../../core/contracts.js";
import { TRADING_API_CHAINS, deploymentFor, TRADING_API_BASE } from "./deployments.js";
import { decodeUniversalRouterCalldata, UniswapDecodeError, UNIVERSAL_ROUTER_ABI, COMMANDS } from "./decoder.js";

/**
 * Uniswap execution adapter.
 *
 * Two modes behind one interface:
 *
 *  - `trading-api` — the hosted routing service. Mainnet only (FND-V2-007), so it is never selected
 *    for a Sepolia build; the manifest declares the API's real chain list so that refusal is
 *    structural rather than a convention someone has to remember.
 *  - `universal-router` — direct construction against the verified Sepolia deployment. This is the
 *    mode a testnet-only project actually uses.
 *
 * Both modes converge on the same validation. Whatever produced the calldata, it is decoded from the
 * bytes and compared against the intent before anything signs it — because the provider that built
 * the transaction is also the provider describing it, and those two things should not be checked
 * against each other.
 */

export type UniswapMode = "trading-api" | "universal-router";

export interface UniswapSwapIntent {
  action: "SWAP";
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  recipient: string;
  slippageBps: number;
  deadline: string;
}

/** Exactly the shape the live `/swap` endpoint returns, plus the quote it came from. */
export interface UniswapPrepared {
  mode: UniswapMode;
  swap: {
    to: string;
    data: string;
    value: string;
    from: string;
    chainId: number;
    gasLimit?: string;
  };
  /**
   * The provider's own account of what it built.
   *
   * Present because a real integration receives it, and deliberately NEVER read by
   * `decodeTransaction`. It exists in this type so a test can prove the decoder ignores it.
   */
  quote: {
    quoteId?: string;
    amountOut?: string;
    minAmountOut?: string;
    recipientSummary?: string;
    createdAtMs: number;
  };
}

const SEPOLIA = 11155111;

function manifestFor(mode: UniswapMode): ContextLockAdapterManifest {
  const hosted = mode === "trading-api";
  return {
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    id: hosted ? "uniswap-trading-api" : "uniswap-universal-router",
    version: "1.0.0",
    adapterType: "EXECUTION",
    name: hosted ? "Uniswap Trading API" : "Uniswap Universal Router",
    description: hosted
      ? "Hosted Uniswap routing and unsigned transaction construction. Mainnet only; the returned transaction is untrusted until independently decoded."
      : "Direct Universal Router construction against a verified deployment. The built transaction is untrusted until independently decoded.",
    provider: "uniswap",
    // The hosted API's real chain list. Sepolia is absent, so the resolver cannot select it here.
    supportedChains: hosted ? [...TRADING_API_CHAINS] : [SEPOLIA],
    capabilities: [
      { name: "TOKEN_SWAP", description: "Swap an exact input amount for another token." },
      { name: "QUOTE", description: "Obtain a route and expected output for a swap." },
      { name: "APPROVAL_CHECK", description: "Determine whether a token approval is required." },
    ],
    inputSchema: {
      tokenIn: "address",
      tokenOut: "address",
      amountIn: "uint256",
      recipient: "address",
      slippageBps: "number",
      deadline: "uint256",
    },
    outputSchema: { to: "address", data: "bytes", value: "uint256", chainId: "number" },
    // An execution adapter reports what a third party built. That is a proposal, not an observation.
    trustClass: "USER_UNTRUSTED",
    freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
    auth: hosted
      ? { mode: "api-key", requiredSecretNames: ["UNISWAP_TRADING_API_KEY"], placement: "studio-backend" }
      : { mode: "none", requiredSecretNames: [], placement: "never-client" },
    permissionsRequired: ["SWAP"],
    executionPlacement: "studio-backend",
    safety: {
      decodesPreparedTransactions: true,
      supportsDryRun: true,
      allowsArbitraryTarget: false,
      allowsArbitraryRecipient: false,
      independentlyValidatesProviderOutput: true,
    },
    generatedModules: [
      { path: `src/adapters/${hosted ? "uniswap-trading-api" : "uniswap-universal-router"}/adapter.ts`, kind: "adapter-runtime" },
      { path: `src/adapters/${hosted ? "uniswap-trading-api" : "uniswap-universal-router"}/config.ts`, kind: "adapter-config" },
    ],
    simulationProviders: [
      "UNI-NORMAL",
      "UNI-HIGH_SLIPPAGE",
      "UNI-RECIPIENT_SUBSTITUTION",
      "UNI-AMOUNT_MUTATION",
      "UNI-WRONG_ROUTER",
      "UNI-EXPIRED_QUOTE",
      "UNI-UNEXPECTED_APPROVAL",
      "UNI-PRICE_MOVEMENT",
      "UNI-ROUTE_CHANGED",
    ],
    securityAssertions: [
      {
        id: "AS-UNI-1",
        statement: "The transaction is decoded from its calldata; the provider's quote summary is never read.",
        provenBy: ["UNI-002", "UNI-003"],
      },
      { id: "AS-UNI-2", statement: "A substituted recipient is rejected before capability issuance.", provenBy: ["UNI-003"] },
      { id: "AS-UNI-3", statement: "An unexpected or unlimited approval is rejected.", provenBy: ["UNI-006", "UNI-007"] },
      { id: "AS-UNI-4", statement: "A router command the adapter cannot decode is refused, not skipped.", provenBy: ["UNI-013"] },
      { id: "AS-UNI-5", statement: "A stale quote cannot authorize execution.", provenBy: ["UNI-008"] },
    ],
    documentation: {
      officialDocs: [
        "https://trade-api.gateway.uniswap.org/v1/api.json",
        "https://developers.uniswap.org/docs/protocols/v4/deployments",
      ],
      verifiedOn: "2026-09-08",
      notes: hosted
        ? `Endpoints verified live: /check_approval /quote /swap /order /orders /swaps /plan. Base ${TRADING_API_BASE}. No testnet — see FND-V2-007.`
        : "Sepolia Universal Router and Permit2 addresses verified from the official deployments page.",
    },
  };
}

export const uniswapTradingApiManifest = manifestFor("trading-api");
export const uniswapUniversalRouterManifest = manifestFor("universal-router");

/** Deterministic transaction builder standing in for a live provider. Replaceable in tests. */
export type UniswapBuilder = (intent: UniswapSwapIntent) => UniswapPrepared;

export class UniswapExecutionAdapter implements ExecutionAdapter<UniswapSwapIntent, UniswapPrepared> {
  constructor(
    private readonly mode: UniswapMode = "universal-router",
    private readonly builder?: UniswapBuilder,
  ) {}

  manifest(): ContextLockAdapterManifest {
    return this.mode === "trading-api" ? uniswapTradingApiManifest : uniswapUniversalRouterManifest;
  }

  supportedActions(): string[] {
    return ["SWAP"];
  }

  normalizeIntent(intent: unknown) {
    const i = intent as UniswapSwapIntent;
    const problems: ValidationProblem[] = [];
    const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

    if (!i || i.action !== "SWAP") {
      problems.push({ code: "UNI-I0", severity: "CRITICAL", field: "action", message: "only SWAP is supported" });
    }
    if (!addr(i?.tokenIn)) problems.push({ code: "UNI-I1", severity: "CRITICAL", field: "tokenIn", message: "tokenIn must be an address" });
    if (!addr(i?.tokenOut)) problems.push({ code: "UNI-I2", severity: "CRITICAL", field: "tokenOut", message: "tokenOut must be an address" });
    if (!addr(i?.recipient)) problems.push({ code: "UNI-I3", severity: "CRITICAL", field: "recipient", message: "recipient must be an address" });
    if (!/^\d+$/.test(String(i?.amountIn))) {
      problems.push({ code: "UNI-I4", severity: "CRITICAL", field: "amountIn", message: "amountIn must be integer base units" });
    }
    if (typeof i?.slippageBps !== "number" || i.slippageBps < 0 || i.slippageBps > 10_000) {
      problems.push({ code: "UNI-I5", severity: "HIGH", field: "slippageBps", message: "slippageBps must be 0-10000" });
    }
    if (addr(i?.tokenIn) && addr(i?.tokenOut) && i.tokenIn.toLowerCase() === i.tokenOut.toLowerCase()) {
      problems.push({ code: "UNI-I6", severity: "HIGH", field: "tokenOut", message: "tokenIn and tokenOut are the same token" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, intent: i } as const);
  }

  async buildTransaction(intent: UniswapSwapIntent, ctx: AdapterExecutionContext): Promise<UniswapPrepared> {
    if (this.builder) return this.builder(intent);

    /*
     * Default construction for the direct mode.
     *
     * In the hosted mode this is where `POST /quote` then `POST /swap` would run. No live call is
     * made in this build: the hosted API has no testnet (FND-V2-007), and a mainnet call to produce
     * evidence would trade the project's Sepolia-only constraint for a screenshot.
     */
    const d = deploymentFor(intent.chainId);
    const minOut = (BigInt(intent.amountIn) * BigInt(10_000 - intent.slippageBps)) / 10_000n;
    const path = `0x${intent.tokenIn.slice(2)}000bb8${intent.tokenOut.slice(2)}`;
    const input = encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
      getAddress(intent.recipient),
      BigInt(intent.amountIn),
      minOut,
      path as `0x${string}`,
      true,
    ]);
    const data = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [`0x${COMMANDS.V3_SWAP_EXACT_IN.toString(16).padStart(2, "0")}` as `0x${string}`, [input], BigInt(intent.deadline)],
    });

    return {
      mode: this.mode,
      swap: { to: d.universalRouter, data, value: "0", from: ctx.owner, chainId: intent.chainId },
      quote: {
        quoteId: "local",
        amountOut: minOut.toString(),
        minAmountOut: minOut.toString(),
        recipientSummary: intent.recipient,
        createdAtMs: ctx.nowMs,
      },
    };
  }

  /**
   * Decode from `swap.data`.
   *
   * `prepared.quote` is in scope and is not touched. That is the point of the method.
   */
  async decodeTransaction(prepared: UniswapPrepared): Promise<NormalizedAction> {
    const decoded = decodeUniversalRouterCalldata(prepared.swap.data, prepared.swap.from);
    return {
      chainId: prepared.swap.chainId,
      target: getAddress(prepared.swap.to),
      calldata: prepared.swap.data,
      value: prepared.swap.value,
      actionType: "SWAP",
      inputs: decoded.tokenIn && decoded.amountIn ? [{ token: decoded.tokenIn, amount: decoded.amountIn }] : [],
      outputs: decoded.tokenOut && decoded.amountOutMin ? [{ token: decoded.tokenOut, amount: decoded.amountOutMin }] : [],
      ...(decoded.finalRecipient ? { recipient: decoded.finalRecipient } : {}),
      allowanceChanges: decoded.approvals,
      minOutputs: decoded.tokenOut && decoded.amountOutMin ? [{ token: decoded.tokenOut, amount: decoded.amountOutMin }] : [],
      ...(decoded.deadline ? { deadline: decoded.deadline } : {}),
      // Recorded for display only. No validation rule below consults it.
      providerMetadata: { quote: prepared.quote, commands: decoded.commands.map((c) => c.name), mode: prepared.mode },
    };
  }

  validateTransaction(n: NormalizedAction, intent: UniswapSwapIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string, severity: ValidationProblem["severity"] = "CRITICAL") =>
      problems.push({ code, severity, field, message });

    if (n.chainId !== c.chainId) P("UNI-V-CHAIN", "chainId", `decoded chain ${n.chainId} != policy chain ${c.chainId}`);

    if (!c.allowedTargets.map((t) => t.toLowerCase()).includes(n.target.toLowerCase())) {
      P("UNI-V-ROUTER", "target", `router ${n.target} is not in the allow-list`);
    }

    /*
     * Recipient. The single most valuable check in this adapter.
     *
     * A routing provider that substitutes the recipient produces a transaction that is correct in
     * every other respect — right tokens, right amount, plausible route — and sends the proceeds
     * somewhere else.
     */
    const decodedRecipient = (n.recipient ?? "").toLowerCase();
    if (!decodedRecipient) {
      P("UNI-V-RECIPIENT-MISSING", "recipient", "no recipient could be decoded from the calldata");
    } else {
      if (decodedRecipient !== intent.recipient.toLowerCase()) {
        P("UNI-V-RECIPIENT", "recipient", `decoded recipient ${n.recipient} does not match the intended ${intent.recipient}`);
      }
      if (c.allowedRecipients === "self-only") {
        if (decodedRecipient !== c.owner.toLowerCase()) {
          P("UNI-V-RECIPIENT-SELF", "recipient", `policy is self-only; decoded ${n.recipient}`);
        }
      } else if (!c.allowedRecipients.map((r) => r.toLowerCase()).includes(decodedRecipient)) {
        P("UNI-V-RECIPIENT-ALLOW", "recipient", `decoded recipient ${n.recipient} is not allow-listed`);
      }
    }

    const decodedIn = n.inputs[0];
    if (!decodedIn) {
      P("UNI-V-NO-INPUT", "inputs", "no input token/amount could be decoded");
    } else {
      if (decodedIn.amount !== intent.amountIn) {
        P("UNI-V-AMOUNT", "amountIn", `decoded amount ${decodedIn.amount} does not match the intended ${intent.amountIn}`);
      }
      if (decodedIn.token.toLowerCase() !== intent.tokenIn.toLowerCase()) {
        P("UNI-V-TOKEN-IN", "tokenIn", `decoded tokenIn ${decodedIn.token} does not match the intended ${intent.tokenIn}`);
      }
    }

    const decodedOut = n.outputs[0];
    if (decodedOut && decodedOut.token.toLowerCase() !== intent.tokenOut.toLowerCase()) {
      P("UNI-V-TOKEN-OUT", "tokenOut", `decoded tokenOut ${decodedOut.token} does not match the intended ${intent.tokenOut}`);
    }

    /*
     * Slippage. Checked as a floor on the decoded minimum output rather than by trusting a
     * `slippage` field: weakening minOut is how a route is made to look fine while permitting a far
     * worse execution than the user agreed to.
     */
    if (decodedIn && decodedOut) {
      const maxBps = c.maxSlippageBps ?? intent.slippageBps;
      const floor = (BigInt(intent.amountIn) * BigInt(10_000 - maxBps)) / 10_000n;
      if (BigInt(decodedOut.amount) < floor) {
        P(
          "UNI-V-SLIPPAGE",
          "minOutputs",
          `decoded minimum output ${decodedOut.amount} is below the floor ${floor} implied by ${maxBps}bps`,
        );
      }
    }

    for (const a of n.allowanceChanges) {
      if (a.unlimited && !c.allowUnlimitedApprovals) {
        P("UNI-V-UNLIMITED-APPROVAL", "allowanceChanges", `unlimited approval to ${a.spender} is not permitted`);
      }
      if (c.maxApprovalAmount && BigInt(a.amount) > BigInt(c.maxApprovalAmount)) {
        P("UNI-V-APPROVAL-SIZE", "allowanceChanges", `approval ${a.amount} exceeds the cap ${c.maxApprovalAmount}`);
      }
      // An approval to anything other than the router or Permit2 is not part of a swap.
      const permitted = [n.target.toLowerCase(), deploymentFor(c.chainId).permit2.toLowerCase()];
      if (!permitted.includes(a.spender.toLowerCase())) {
        P("UNI-V-APPROVAL-SPENDER", "allowanceChanges", `unexpected approval spender ${a.spender}`);
      }
    }

    if (n.deadline && BigInt(n.deadline) * 1000n < BigInt(Date.now())) {
      P("UNI-V-DEADLINE", "deadline", `router deadline ${n.deadline} has already passed`, "HIGH");
    }

    return problems.length > 0 ? invalid(problems) : valid();
  }

  /** Quote age is checked separately: it bounds how long a route may be acted on. */
  validateQuoteFreshness(prepared: UniswapPrepared, c: ExecutionConstraints, nowMs: number): ValidationResult {
    const age = nowMs - prepared.quote.createdAtMs;
    if (age > c.maxQuoteAgeMs) {
      return invalid([
        {
          code: "UNI-V-STALE-QUOTE",
          severity: "CRITICAL",
          field: "quote",
          message: `quote is ${age}ms old, limit is ${c.maxQuoteAgeMs}ms; a stale route prices a market that has moved`,
        },
      ]);
    }
    return valid();
  }

  /**
   * Concrete provider responses, one per declared scenario.
   *
   * These carry real calldata rather than a declared expectation, because the harness EXECUTES
   * them: it runs this adapter's own decoder and validator and reports what actually happened. A
   * fixture that merely asserted "REJECTED" would prove nothing about whether the adapter would
   * really reject it, which is the only thing the scenario is evidence for.
   */
  createSimulationFixtures(): AdapterSimulationFixture[] {
    const chainId = this.mode === "trading-api" ? TRADING_API_CHAINS[0] : SEPOLIA;
    const d = this.mode === "trading-api" ? undefined : deploymentFor(SEPOLIA);
    const router = d?.universalRouter ?? "0x0000000000000000000000000000000000000001";
    const owner = "0x0000000000000000000000000000000000005e1f";
    const attacker = "0x000000000000000000000000000000000000dEaD";
    const tokenIn = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    const tokenOut = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
    const amountIn = 500_000_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const calldata = (o: { recipient?: string; amountIn?: bigint; minOut?: bigint; command?: number; approval?: { spender: string; amount: bigint } } = {}) => {
      const rec = o.recipient ?? owner;
      const amt = o.amountIn ?? amountIn;
      const min = o.minOut ?? (amt * 9_950n) / 10_000n;
      const path = `0x${tokenIn.slice(2)}000bb8${tokenOut.slice(2)}` as `0x${string}`;
      const swap = encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
        getAddress(rec), amt, min, path, true,
      ]) as `0x${string}`;
      const cmds: number[] = [];
      const ins: `0x${string}`[] = [];
      if (o.approval) {
        cmds.push(COMMANDS.PERMIT2_PERMIT);
        ins.push(
          encodeAbiParameters(parseAbiParameters("((address,uint160,uint48,uint48),address,uint256), bytes"), [
            [[getAddress(tokenIn), o.approval.amount, 0, 0], getAddress(o.approval.spender), 0n],
            "0x",
          ]) as `0x${string}`,
        );
      }
      cmds.push(o.command ?? COMMANDS.V3_SWAP_EXACT_IN);
      ins.push(swap);
      return encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [`0x${cmds.map((c) => c.toString(16).padStart(2, "0")).join("")}` as `0x${string}`, ins, deadline],
      });
    };

    const mk = (data: string, over: Partial<UniswapPrepared["swap"]> = {}, ageMs = 0): UniswapPrepared => ({
      mode: this.mode,
      swap: { to: router, data, value: "0", from: owner, chainId, ...over },
      // Always the HONEST summary. If any validation read it, every attack fixture would pass.
      quote: { quoteId: "sim", amountOut: "1", minAmountOut: "1", recipientSummary: owner, createdAtMs: Date.now() - ageMs },
    });

    const unlimited = (1n << 160n) - 1n;
    const spec: Array<[string, string, UniswapPrepared, "ACCEPTED" | "REJECTED"]> = [
      ["UNI-NORMAL", "Provider builds exactly the requested swap.", mk(calldata()), "ACCEPTED"],
      ["UNI-PRICE_MOVEMENT", "Price moved within the agreed slippage band.", mk(calldata({ minOut: (amountIn * 9_960n) / 10_000n })), "ACCEPTED"],
      ["UNI-RECIPIENT_SUBSTITUTION", "Calldata pays an attacker while the quote claims the owner.", mk(calldata({ recipient: attacker })), "REJECTED"],
      ["UNI-AMOUNT_MUTATION", "Input amount inflated in the calldata.", mk(calldata({ amountIn: 9_999_999_999n })), "REJECTED"],
      ["UNI-WRONG_ROUTER", "Transaction targets a router outside the verified deployment.", mk(calldata(), { to: attacker }), "REJECTED"],
      ["UNI-HIGH_SLIPPAGE", "Minimum output weakened while everything else matches.", mk(calldata({ minOut: 1n })), "REJECTED"],
      ["UNI-EXPIRED_QUOTE", "Route priced against a market that has since moved.", mk(calldata(), {}, 120_000), "REJECTED"],
      ["UNI-UNEXPECTED_APPROVAL", "An unlimited approval to an unexpected spender is smuggled in.", mk(calldata({ approval: { spender: attacker, amount: unlimited } })), "REJECTED"],
      ["UNI-ROUTE_CHANGED", "Route uses a router command this adapter cannot fully decode.", mk(calldata({ command: COMMANDS.V4_SWAP })), "REJECTED"],
    ];

    return spec.map(([scenarioId, description, providerResponse, outcome]) => ({
      scenarioId,
      description,
      providerResponse,
      expected: outcome === "ACCEPTED" ? { outcome: "ACCEPTED" } : { outcome: "REJECTED", reasonCodeMatches: "UNI-" },
    }));
  }

  /** The intent every fixture is validated against. Exposed so the harness need not reinvent it. */
  fixtureIntent(): UniswapSwapIntent {
    return {
      action: "SWAP",
      chainId: this.mode === "trading-api" ? TRADING_API_CHAINS[0] : SEPOLIA,
      tokenIn: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      tokenOut: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      amountIn: "500000000",
      recipient: "0x0000000000000000000000000000000000005e1f",
      slippageBps: 50,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
    };
  }

  /** Constraints the fixtures are judged under. */
  fixtureConstraints(): ExecutionConstraints {
    const d = deploymentFor(SEPOLIA);
    return {
      chainId: this.mode === "trading-api" ? TRADING_API_CHAINS[0] : SEPOLIA,
      allowedTargets: [d.universalRouter],
      allowedRecipients: "self-only",
      owner: "0x0000000000000000000000000000000000005e1f",
      maxSlippageBps: 50,
      allowUnlimitedApprovals: false,
      maxQuoteAgeMs: 30_000,
    };
  }

  generateTemplateConfig() {
    const m = this.manifest();
    return {
      adapterId: m.id,
      mode: this.mode,
      ...(this.mode === "universal-router"
        ? { deployment: deploymentFor(SEPOLIA) }
        : { baseUrl: TRADING_API_BASE, chains: TRADING_API_CHAINS }),
    };
  }
}

export { UniswapDecodeError };
