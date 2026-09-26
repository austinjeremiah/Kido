import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, getAddress } from "viem";

/**
 * Independent Universal Router calldata decoder.
 *
 * This is the security core of the Uniswap adapter, and its defining property is what it does NOT
 * read: the provider's own description of what it built.
 *
 * A hosted routing API returns both a human-readable quote summary and the calldata to sign. Those
 * two are produced by the same party. A compromised or buggy provider returns a benign summary
 * beside calldata that pays someone else, and any validation performed against the summary agrees
 * with it perfectly. The only description of a transaction that cannot lie is the bytes that will
 * execute.
 *
 * So everything here is derived from `data`. Nothing is taken from the quote.
 *
 * Unrecognised commands are a REFUSAL, not a skip. A router command this decoder does not
 * understand may move funds in a way no downstream check would catch, and "we didn't recognise it
 * so we ignored it" is how an unvalidated transfer gets signed.
 */

export class UniswapDecodeError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "UniswapDecodeError";
  }
}

/** Universal Router command bytes, from the router's Commands library. */
export const COMMANDS = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

const COMMAND_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(COMMANDS).map(([k, v]) => [v, k]),
);

/**
 * Recipient sentinels the router understands.
 *
 * `0x...0001` means "the router itself" and `0x...0002` means "the message sender". A decoder that
 * reported the sentinel literally would make a self-directed swap look like a payment to a
 * near-zero address, and a reviewer would either panic or, worse, learn to ignore it.
 */
export const RECIPIENT_ROUTER = "0x0000000000000000000000000000000000000001";
export const RECIPIENT_SENDER = "0x0000000000000000000000000000000000000002";

export const UNIVERSAL_ROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

export interface DecodedCommand {
  index: number;
  command: number;
  name: string;
  recipient?: string;
  amountIn?: string;
  amountOutMin?: string;
  tokenPath?: string[];
  spender?: string;
  approvalAmount?: string;
  approvalUnlimited?: boolean;
}

export interface DecodedRouterCall {
  deadline?: string;
  commands: DecodedCommand[];
  /** Recipient of the final swap output, resolved through the sentinels. */
  finalRecipient?: string;
  amountIn?: string;
  amountOutMin?: string;
  tokenIn?: string;
  tokenOut?: string;
  approvals: Array<{ token: string; spender: string; amount: string; unlimited: boolean }>;
}

/** A v3 path is `token (20) | fee (3) | token (20) | ...`. */
function decodeV3Path(path: string): string[] {
  const hex = path.startsWith("0x") ? path.slice(2) : path;
  if (hex.length < 40 + 6 + 40) {
    throw new UniswapDecodeError("UNI-PATH-SHORT", `v3 path is too short to contain one hop: ${path}`);
  }
  if ((hex.length - 40) % 46 !== 0) {
    throw new UniswapDecodeError("UNI-PATH-MALFORMED", `v3 path length ${hex.length} is not a whole number of hops`);
  }
  const tokens: string[] = [getAddress(`0x${hex.slice(0, 40)}`)];
  for (let i = 40; i + 46 <= hex.length; i += 46) {
    tokens.push(getAddress(`0x${hex.slice(i + 6, i + 46)}`));
  }
  return tokens;
}

/** Permit2 uses uint160 max as its unlimited sentinel, not uint256 max. */
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function resolveRecipient(raw: string, swapper: string): string {
  const a = raw.toLowerCase();
  if (a === RECIPIENT_ROUTER.toLowerCase()) return RECIPIENT_ROUTER;
  if (a === RECIPIENT_SENDER.toLowerCase()) return swapper;
  return getAddress(raw);
}

/**
 * Decode `UniversalRouter.execute(...)` from raw calldata.
 *
 * @param swapper the address the router treats as the sender, used to resolve the sentinel. Supplied
 *                by the CALLER from its own intent — never read from the provider's response, which
 *                would let the provider define what "me" means.
 */
export function decodeUniversalRouterCalldata(calldata: string, swapper: string): DecodedRouterCall {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: calldata as `0x${string}` });
  } catch (e) {
    throw new UniswapDecodeError("UNI-NOT-ROUTER-CALL", `calldata is not a UniversalRouter.execute call: ${(e as Error).message}`);
  }
  if (decoded.functionName !== "execute") {
    throw new UniswapDecodeError("UNI-UNEXPECTED-FUNCTION", `expected execute, got ${decoded.functionName}`);
  }

  const args = decoded.args as readonly unknown[];
  const commandBytes = args[0] as string;
  const inputs = args[1] as readonly `0x${string}`[];
  const deadline = args.length > 2 ? String(args[2] as bigint) : undefined;

  const hex = commandBytes.startsWith("0x") ? commandBytes.slice(2) : commandBytes;
  const commandCount = hex.length / 2;
  if (commandCount !== inputs.length) {
    // A mismatch means the call is malformed or crafted; either way it is not safe to interpret.
    throw new UniswapDecodeError(
      "UNI-COMMAND-INPUT-MISMATCH",
      `${commandCount} commands but ${inputs.length} inputs`,
    );
  }

  const commands: DecodedCommand[] = [];
  const approvals: DecodedRouterCall["approvals"] = [];
  let amountIn: string | undefined;
  let amountOutMin: string | undefined;
  let tokenIn: string | undefined;
  let tokenOut: string | undefined;
  let finalRecipient: string | undefined;

  for (let i = 0; i < commandCount; i++) {
    // The top bit is the ALLOW_REVERT flag; the command is the low 6 bits.
    const raw = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const command = raw & 0x3f;
    const name = COMMAND_NAMES[command] ?? `UNKNOWN_0x${command.toString(16)}`;
    const input = inputs[i]!;
    const entry: DecodedCommand = { index: i, command, name };

    switch (command) {
      case COMMANDS.V3_SWAP_EXACT_IN: {
        const [recipient, aIn, aOutMin, path] = decodeAbiParameters(
          parseAbiParameters("address, uint256, uint256, bytes, bool"),
          input,
        ) as unknown as [string, bigint, bigint, string, boolean];
        const tokens = decodeV3Path(path);
        entry.recipient = resolveRecipient(recipient, swapper);
        entry.amountIn = aIn.toString();
        entry.amountOutMin = aOutMin.toString();
        entry.tokenPath = tokens;
        amountIn ??= entry.amountIn;
        amountOutMin = entry.amountOutMin;
        tokenIn ??= tokens[0];
        tokenOut = tokens[tokens.length - 1];
        finalRecipient = entry.recipient;
        break;
      }
      case COMMANDS.V2_SWAP_EXACT_IN: {
        const [recipient, aIn, aOutMin, path] = decodeAbiParameters(
          parseAbiParameters("address, uint256, uint256, address[], bool"),
          input,
        ) as unknown as [string, bigint, bigint, string[], boolean];
        entry.recipient = resolveRecipient(recipient, swapper);
        entry.amountIn = aIn.toString();
        entry.amountOutMin = aOutMin.toString();
        entry.tokenPath = path.map((t) => getAddress(t));
        amountIn ??= entry.amountIn;
        amountOutMin = entry.amountOutMin;
        tokenIn ??= entry.tokenPath[0];
        tokenOut = entry.tokenPath[entry.tokenPath.length - 1];
        finalRecipient = entry.recipient;
        break;
      }
      case COMMANDS.PERMIT2_PERMIT: {
        /*
         * The approval command. Decoded because an unexpected or unlimited approval is one of the
         * most damaging things a router call can smuggle in — it outlives the transaction.
         */
        const [details, spender] = decodeAbiParameters(
          parseAbiParameters("((address,uint160,uint48,uint48),address,uint256), bytes"),
          input,
        ) as unknown as [[[string, bigint, number, number], string, bigint], string];
        const [[token, amount], sp] = details;
        entry.spender = getAddress(sp);
        entry.approvalAmount = amount.toString();
        entry.approvalUnlimited = amount >= UINT160_MAX;
        approvals.push({
          token: getAddress(token),
          spender: entry.spender,
          amount: entry.approvalAmount,
          unlimited: entry.approvalUnlimited,
        });
        void spender;
        break;
      }
      case COMMANDS.SWEEP:
      case COMMANDS.TRANSFER:
      case COMMANDS.PAY_PORTION: {
        // These move funds directly. Decode the recipient so it is checked like any other.
        const [token, recipient, amount] = decodeAbiParameters(
          parseAbiParameters("address, address, uint256"),
          input,
        ) as unknown as [string, string, bigint];
        entry.recipient = resolveRecipient(recipient, swapper);
        entry.amountIn = amount.toString();
        entry.tokenPath = [getAddress(token)];
        finalRecipient ??= entry.recipient;
        break;
      }
      case COMMANDS.WRAP_ETH:
      case COMMANDS.UNWRAP_WETH: {
        const [recipient, amount] = decodeAbiParameters(
          parseAbiParameters("address, uint256"),
          input,
        ) as unknown as [string, bigint];
        entry.recipient = resolveRecipient(recipient, swapper);
        entry.amountIn = amount.toString();
        break;
      }
      default:
        /*
         * FAIL CLOSED.
         *
         * V3_SWAP_EXACT_OUT, V4_SWAP, PERMIT2_TRANSFER_FROM and anything the router adds later land
         * here. Refusing is deliberate: an unrecognised command may move funds in a way nothing
         * downstream would notice, and a decoder that shrugs at bytes it does not understand is
         * worse than no decoder, because it produces a confident-looking result.
         */
        throw new UniswapDecodeError(
          "UNI-UNSUPPORTED-COMMAND",
          `router command ${name} (0x${command.toString(16).padStart(2, "0")}) is not decoded by this adapter; refusing to authorize a call it cannot fully read`,
        );
    }
    commands.push(entry);
  }

  if (commands.length === 0) {
    throw new UniswapDecodeError("UNI-NO-COMMANDS", "router call contains no commands");
  }

  return {
    ...(deadline !== undefined ? { deadline } : {}),
    commands,
    ...(finalRecipient !== undefined ? { finalRecipient } : {}),
    ...(amountIn !== undefined ? { amountIn } : {}),
    ...(amountOutMin !== undefined ? { amountOutMin } : {}),
    ...(tokenIn !== undefined ? { tokenIn } : {}),
    ...(tokenOut !== undefined ? { tokenOut } : {}),
    approvals,
  };
}

/** Detect an unlimited ERC-20 approval in a plain `approve(address,uint256)` call. */
export function decodeErc20Approve(calldata: string): { spender: string; amount: string; unlimited: boolean } | null {
  if (!calldata.startsWith("0x095ea7b3")) return null;
  const [spender, amount] = decodeAbiParameters(
    parseAbiParameters("address, uint256"),
    `0x${calldata.slice(10)}` as `0x${string}`,
  ) as unknown as [string, bigint];
  return { spender: getAddress(spender), amount: amount.toString(), unlimited: amount >= UINT256_MAX };
}
