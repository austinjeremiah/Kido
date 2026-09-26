import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, getAddress } from "viem";
import {
  AdapterRegistry,
  UniswapExecutionAdapter,
  UniswapDecodeError,
  uniswapTradingApiManifest,
  uniswapUniversalRouterManifest,
  decodeUniversalRouterCalldata,
  decodeErc20Approve,
  deploymentFor,
  UNIVERSAL_ROUTER_ABI,
  COMMANDS,
  RECIPIENT_SENDER,
  resolveDataRequirement,
  type ExecutionConstraints,
  type UniswapPrepared,
  type UniswapSwapIntent,
} from "../src/index.js";

const SEPOLIA = 11155111;
const D = deploymentFor(SEPOLIA);
const OWNER = "0x0000000000000000000000000000000000005e1f";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

const intent: UniswapSwapIntent = {
  action: "SWAP",
  chainId: SEPOLIA,
  tokenIn: USDC,
  tokenOut: WETH,
  amountIn: "500000000",
  recipient: OWNER,
  slippageBps: 50,
  deadline: String(Math.floor(Date.now() / 1000) + 600),
};

const constraints: ExecutionConstraints = {
  chainId: SEPOLIA,
  allowedTargets: [D.universalRouter],
  allowedRecipients: "self-only",
  owner: OWNER,
  maxSlippageBps: 50,
  allowUnlimitedApprovals: false,
  maxQuoteAgeMs: 30_000,
};

const ctx = { chainId: SEPOLIA, owner: OWNER, nowMs: Date.now() };

/**
 * Build router calldata directly, so a test can construct exactly the transaction a hostile or
 * buggy provider would return. This is the only way to prove the decoder catches it — a real
 * provider will not substitute a recipient on request.
 */
function routerCalldata(over: {
  recipient?: string;
  amountIn?: bigint;
  minOut?: bigint;
  tokenIn?: string;
  tokenOut?: string;
  command?: number;
  deadline?: bigint;
  extraApproval?: { token: string; spender: string; amount: bigint };
} = {}): string {
  const recipient = over.recipient ?? OWNER;
  const amountIn = over.amountIn ?? BigInt(intent.amountIn);
  const minOut = over.minOut ?? (amountIn * 9950n) / 10_000n;
  const tokenIn = over.tokenIn ?? USDC;
  const tokenOut = over.tokenOut ?? WETH;
  const path = `0x${tokenIn.slice(2)}000bb8${tokenOut.slice(2)}` as `0x${string}`;

  const swapInput = encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
    getAddress(recipient),
    amountIn,
    minOut,
    path,
    true,
  ]);

  const commands: number[] = [];
  const inputs: `0x${string}`[] = [];

  if (over.extraApproval) {
    commands.push(COMMANDS.PERMIT2_PERMIT);
    inputs.push(
      encodeAbiParameters(parseAbiParameters("((address,uint160,uint48,uint48),address,uint256), bytes"), [
        [
          [getAddress(over.extraApproval.token), over.extraApproval.amount, 0, 0],
          getAddress(over.extraApproval.spender),
          0n,
        ],
        "0x",
      ]) as `0x${string}`,
    );
  }

  commands.push(over.command ?? COMMANDS.V3_SWAP_EXACT_IN);
  inputs.push(swapInput as `0x${string}`);

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [
      `0x${commands.map((c) => c.toString(16).padStart(2, "0")).join("")}` as `0x${string}`,
      inputs,
      over.deadline ?? BigInt(intent.deadline),
    ],
  });
}

const prepared = (calldata: string, over: Partial<UniswapPrepared["swap"]> = {}, quoteAgeMs = 0): UniswapPrepared => ({
  mode: "universal-router",
  swap: { to: D.universalRouter, data: calldata, value: "0", from: OWNER, chainId: SEPOLIA, ...over },
  // The provider's summary always claims the HONEST intent, in every fixture below. If any
  // validation read it, every attack here would pass.
  quote: {
    quoteId: "q1",
    amountOut: "1000",
    minAmountOut: "1000",
    recipientSummary: OWNER,
    createdAtMs: Date.now() - quoteAgeMs,
  },
});

const adapter = new UniswapExecutionAdapter("universal-router");

async function validateFixture(calldata: string, over: Partial<UniswapPrepared["swap"]> = {}) {
  const p = prepared(calldata, over);
  const n = await adapter.decodeTransaction(p);
  return { n, result: adapter.validateTransaction(n, intent, constraints) };
}

/* ─────────────────────────────── UNI-001/002 ──────────────────────────────── */

describe("UNI-001 a valid quote normalizes", () => {
  it("builds and decodes a swap that matches the intent", async () => {
    const p = await adapter.buildTransaction(intent, ctx);
    expect(p.swap.to).toBe(D.universalRouter);
    expect(p.swap.chainId).toBe(SEPOLIA);
    const n = await adapter.decodeTransaction(p);
    expect(n.actionType).toBe("SWAP");
    expect(n.recipient?.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(n.inputs[0]?.amount).toBe(intent.amountIn);
    expect(adapter.validateTransaction(n, intent, constraints).ok).toBe(true);
  });
});

describe("UNI-002 a valid transaction is decoded from calldata", () => {
  it("recovers recipient, amount, tokens, minOut and deadline from the bytes", () => {
    const decoded = decodeUniversalRouterCalldata(routerCalldata(), OWNER);
    expect(decoded.finalRecipient?.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(decoded.amountIn).toBe(intent.amountIn);
    expect(decoded.tokenIn?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decoded.tokenOut?.toLowerCase()).toBe(WETH.toLowerCase());
    expect(decoded.commands.map((c) => c.name)).toEqual(["V3_SWAP_EXACT_IN"]);
    expect(decoded.deadline).toBe(intent.deadline);
  });

  it("resolves the router's msg.sender sentinel to the actual swapper", () => {
    // Reporting 0x...0002 literally would make a self-directed swap look like a payment to a
    // near-zero address — either alarming or, worse, something a reviewer learns to ignore.
    const decoded = decodeUniversalRouterCalldata(routerCalldata({ recipient: RECIPIENT_SENDER }), OWNER);
    expect(decoded.finalRecipient?.toLowerCase()).toBe(OWNER.toLowerCase());
  });
});

/* ───────────────────────────── the attack cases ───────────────────────────── */

describe("UNI-003 a substituted recipient is rejected", () => {
  it("catches calldata paying an attacker while the quote claims the owner", async () => {
    const { n, result } = await validateFixture(routerCalldata({ recipient: ATTACKER }));
    // The provider's summary still says the honest recipient...
    expect(prepared(routerCalldata({ recipient: ATTACKER })).quote.recipientSummary).toBe(OWNER);
    // ...and the decode, which reads the bytes, disagrees.
    expect(n.recipient?.toLowerCase()).toBe(ATTACKER.toLowerCase());
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-RECIPIENT");
    expect(result.problems.find((p) => p.code === "UNI-V-RECIPIENT")?.severity).toBe("CRITICAL");
  });

  it("also fails the self-only policy check independently", async () => {
    const { result } = await validateFixture(routerCalldata({ recipient: ATTACKER }));
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-RECIPIENT-SELF");
  });
});

describe("UNI-004 an amount substitution is rejected", () => {
  it("catches an inflated input amount", async () => {
    const { result } = await validateFixture(routerCalldata({ amountIn: 9_999_999_999n }));
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-AMOUNT");
  });
});

describe("UNI-005 a wrong router is rejected", () => {
  it("refuses a target outside the verified deployment allow-list", async () => {
    const { result } = await validateFixture(routerCalldata(), { to: ATTACKER });
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-ROUTER");
  });
});

describe("UNI-006/007 approval security", () => {
  it("rejects an unlimited Permit2 approval smuggled into the call", async () => {
    const unlimited = (1n << 160n) - 1n;
    const { n, result } = await validateFixture(
      routerCalldata({ extraApproval: { token: USDC, spender: D.universalRouter, amount: unlimited } }),
    );
    expect(n.allowanceChanges[0]?.unlimited).toBe(true);
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-UNLIMITED-APPROVAL");
  });

  it("rejects an approval to an unexpected spender", async () => {
    const { result } = await validateFixture(
      routerCalldata({ extraApproval: { token: USDC, spender: ATTACKER, amount: 1000n } }),
    );
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-APPROVAL-SPENDER");
  });

  it("accepts a bounded approval to the router itself", async () => {
    const { result } = await validateFixture(
      routerCalldata({ extraApproval: { token: USDC, spender: D.universalRouter, amount: 500_000_000n } }),
    );
    expect(result.problems.filter((p) => p.code.startsWith("UNI-V-APPROVAL"))).toEqual([]);
    expect(result.problems.filter((p) => p.code === "UNI-V-UNLIMITED-APPROVAL")).toEqual([]);
  });

  it("rejects an approval above a declared cap", async () => {
    const capped = { ...constraints, maxApprovalAmount: "1000" };
    const p = prepared(routerCalldata({ extraApproval: { token: USDC, spender: D.universalRouter, amount: 999_999n } }));
    const n = await adapter.decodeTransaction(p);
    expect(adapter.validateTransaction(n, intent, capped).problems.map((x) => x.code)).toContain("UNI-V-APPROVAL-SIZE");
  });

  it("detects an unlimited plain ERC-20 approve", () => {
    const max = (1n << 256n) - 1n;
    const data = `0x095ea7b3${D.universalRouter.slice(2).toLowerCase().padStart(64, "0")}${max.toString(16).padStart(64, "0")}`;
    const a = decodeErc20Approve(data)!;
    expect(a.unlimited).toBe(true);
    expect(a.spender.toLowerCase()).toBe(D.universalRouter.toLowerCase());
  });
});

describe("UNI-008 a stale quote is rejected", () => {
  it("refuses to act on a route priced against a market that has moved", () => {
    const stale = prepared(routerCalldata(), {}, 120_000);
    const r = adapter.validateQuoteFreshness(stale, constraints, Date.now());
    expect(r.ok).toBe(false);
    expect(r.problems[0]!.code).toBe("UNI-V-STALE-QUOTE");
  });

  it("accepts a fresh quote", () => {
    expect(adapter.validateQuoteFreshness(prepared(routerCalldata(), {}, 1_000), constraints, Date.now()).ok).toBe(true);
  });
});

describe("UNI-009 a slippage violation is rejected", () => {
  it("catches a weakened minimum output even when everything else matches", async () => {
    // The subtle one: tokens, amount and recipient are all correct, and the trade can still execute
    // far worse than the user agreed to.
    const { result } = await validateFixture(routerCalldata({ minOut: 1n }));
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-SLIPPAGE");
  });

  it("accepts a minimum output within the policy's slippage floor", async () => {
    const { result } = await validateFixture(routerCalldata({ minOut: (BigInt(intent.amountIn) * 9_960n) / 10_000n }));
    expect(result.problems.filter((p) => p.code === "UNI-V-SLIPPAGE")).toEqual([]);
  });
});

describe("UNI-011 a chain mismatch is rejected", () => {
  it("refuses calldata built for another chain", async () => {
    const { result } = await validateFixture(routerCalldata(), { chainId: 1 });
    expect(result.problems.map((p) => p.code)).toContain("UNI-V-CHAIN");
  });

  it("the hosted adapter cannot be selected for a Sepolia requirement (FND-V2-007)", () => {
    // Structural, not conventional: the manifest declares the API's real chain list.
    expect(uniswapTradingApiManifest.supportedChains).not.toContain(SEPOLIA);
    expect(uniswapUniversalRouterManifest.supportedChains).toEqual([SEPOLIA]);
  });
});

describe("UNI-013 an undecodable command is refused, not skipped", () => {
  it("refuses a router command this adapter does not decode", () => {
    // V4_SWAP is real and unimplemented here. Shrugging at it would produce a confident-looking
    // result for a call that could move funds in a way nothing downstream checks.
    expect(() => decodeUniversalRouterCalldata(routerCalldata({ command: COMMANDS.V4_SWAP }), OWNER)).toThrow(
      UniswapDecodeError,
    );
    expect(() => decodeUniversalRouterCalldata(routerCalldata({ command: COMMANDS.V4_SWAP }), OWNER)).toThrow(
      /UNI-UNSUPPORTED-COMMAND/,
    );
  });

  it("refuses calldata that is not a router call at all", () => {
    expect(() => decodeUniversalRouterCalldata("0xdeadbeef", OWNER)).toThrow(/UNI-NOT-ROUTER-CALL/);
  });

  it("refuses a command/input count mismatch", () => {
    const bad = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: ["0x0000" as `0x${string}`, ["0x00"], 0n],
    });
    expect(() => decodeUniversalRouterCalldata(bad, OWNER)).toThrow(/UNI-COMMAND-INPUT-MISMATCH/);
  });

  it("refuses a malformed v3 path rather than guessing the tokens", () => {
    const shortPath = encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
      getAddress(OWNER),
      1n,
      1n,
      "0x1234" as `0x${string}`,
      true,
    ]);
    const data = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: ["0x00" as `0x${string}`, [shortPath as `0x${string}`], 0n],
    });
    expect(() => decodeUniversalRouterCalldata(data, OWNER)).toThrow(/UNI-PATH/);
  });
});

describe("UNI-012 the adapter registers and pins", () => {
  it("both modes register cleanly and are separately pinned", () => {
    const r = new AdapterRegistry();
    r.register({ kind: "execution", manifest: uniswapUniversalRouterManifest, adapter: new UniswapExecutionAdapter("universal-router") });
    r.register({ kind: "execution", manifest: uniswapTradingApiManifest, adapter: new UniswapExecutionAdapter("trading-api") });
    expect(r.list().map((m) => `${m.id}@${m.version}`).sort()).toEqual([
      "uniswap-trading-api@1.0.0",
      "uniswap-universal-router@1.0.0",
    ]);
  });

  it("declares independent decode + validation, which the registry requires of execution adapters", () => {
    for (const m of [uniswapTradingApiManifest, uniswapUniversalRouterManifest]) {
      expect(m.safety.decodesPreparedTransactions).toBe(true);
      expect(m.safety.independentlyValidatesProviderOutput).toBe(true);
      expect(m.safety.allowsArbitraryRecipient).toBe(false);
      expect(m.trustClass).toBe("USER_UNTRUSTED");
    }
  });

  it("an execution adapter is never selected as a data source", () => {
    const r = new AdapterRegistry();
    r.register({ kind: "execution", manifest: uniswapUniversalRouterManifest, adapter: new UniswapExecutionAdapter() });
    const out = resolveDataRequirement(r, {
      key: "price",
      kind: "eth_usd_price",
      chainId: SEPOLIA,
      minimumTrustClass: "EXTERNAL_API",
      maxAgeMs: 60_000,
      confidential: false,
      historical: false,
    });
    expect(out.ok).toBe(false);
  });
});

describe("UNI-014 prompt injection cannot change the recipient", () => {
  it("an agent-supplied recipient outside the policy is rejected at validation", async () => {
    // The agent proposes the intent, so an injected instruction CAN put an attacker in it. What it
    // cannot do is make the policy accept it.
    const injected: UniswapSwapIntent = { ...intent, recipient: ATTACKER };
    const p = prepared(routerCalldata({ recipient: ATTACKER }));
    const n = await adapter.decodeTransaction(p);
    // Decoded and intended now AGREE — both say attacker. The policy is the thing that refuses.
    const r = adapter.validateTransaction(n, injected, constraints);
    expect(r.ok).toBe(false);
    expect(r.problems.map((x) => x.code)).toContain("UNI-V-RECIPIENT-SELF");
    expect(r.problems.map((x) => x.code)).not.toContain("UNI-V-RECIPIENT");
  });
});

describe("UNI-015 adapter and provider failure fails closed", () => {
  it("a provider returning empty calldata is refused", async () => {
    const p = prepared("0x");
    await expect(adapter.decodeTransaction(p)).rejects.toThrow(UniswapDecodeError);
  });

  it("a builder that throws propagates rather than yielding a partial transaction", async () => {
    const failing = new UniswapExecutionAdapter("universal-router", () => {
      throw new Error("provider unavailable");
    });
    await expect(failing.buildTransaction(intent, ctx)).rejects.toThrow(/provider unavailable/);
  });

  it("refuses to guess a router address for an unrecorded chain", () => {
    expect(() => deploymentFor(999)).toThrow(/refusing to guess a router address/);
  });

  it("a malformed intent is rejected before any provider is contacted", () => {
    const r = adapter.normalizeIntent({ action: "SWAP", chainId: SEPOLIA, tokenIn: "nope", tokenOut: WETH, amountIn: "x", recipient: OWNER, slippageBps: 99_999, deadline: "0" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.map((p) => p.code).sort()).toEqual(["UNI-I1", "UNI-I4", "UNI-I5"]);
    }
  });

  it("rejects a swap where tokenIn equals tokenOut", () => {
    const r = adapter.normalizeIntent({ ...intent, tokenOut: USDC });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code)).toContain("UNI-I6");
  });
});

describe("the decoder never reads the provider's own summary", () => {
  it("produces identical output whatever the quote claims", async () => {
    const honest = prepared(routerCalldata({ recipient: ATTACKER }));
    const lying = {
      ...honest,
      quote: { ...honest.quote, recipientSummary: OWNER, amountOut: "999999999", minAmountOut: "999999999" },
    };
    const a = await adapter.decodeTransaction(honest);
    const b = await adapter.decodeTransaction(lying);
    // providerMetadata carries the quote for display, so compare the security-relevant fields.
    expect({ ...a, providerMetadata: null }).toEqual({ ...b, providerMetadata: null });
    expect(a.recipient?.toLowerCase()).toBe(ATTACKER.toLowerCase());
  });
});
