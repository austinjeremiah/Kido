import type { Address, Hex } from "viem";
import { assertWalletChain } from "./environment.js";
import { sha256Hex } from "./hash.js";
import type { ChainReader } from "./chain.js";
import { fenceWriteByChain } from "@contextlock/studio-network";

/**
 * The wallet signing model.
 *
 * One rule, stated as a type: THE STUDIO SERVER NEVER RECEIVES A DEPLOYMENT PRIVATE KEY.
 *
 * `SignatureRequest` is the whole vocabulary the server has for getting something signed. There is
 * no field for a key, no field for a mnemonic, and no operation that returns one. The server builds
 * a transaction, simulates it, hands the request to a wallet the user controls, and receives a hash
 * back. It cannot do otherwise, because there is nothing in this file that would let it.
 *
 * The second rule: EVERY CANDIDATE TRANSACTION IS SIMULATED BEFORE IT IS OFFERED FOR SIGNATURE. A
 * user asked to sign something that would revert has been asked to pay for nothing.
 */

export type SigningMode = "BROWSER_WALLET" | "LOCAL_BRIDGE_WALLET";

export interface SignatureRequest {
  /** Which manifest signer must produce this. Checked against the connected account. */
  signerId: string;
  mode: SigningMode;
  chainId: number;
  from: Address;
  /** Null for a contract creation. */
  to: Address | null;
  data: Hex;
  value: string;
  gas: string;
  /** What the user is being asked to authorize, in words. Rendered above the wallet prompt. */
  description: string;
  /** sha256 of the exact calldata. Recorded so "did we sign what we planned?" is answerable. */
  calldataHash: string;
  /** Bound to the plan step, so a signature obtained for one step is not reusable for another. */
  deploymentStepId: string;
}

export const SIGNING_REASONS = {
  WRONG_ACCOUNT: "SIGN-WRONG-ACCOUNT",
  WRONG_CHAIN: "SIGN-WRONG-CHAIN",
  NOT_SIMULATED: "SIGN-NOT-SIMULATED",
  SIMULATION_REVERTED: "SIGN-SIMULATION-REVERTED",
  CALLDATA_MISMATCH: "SIGN-CALLDATA-MISMATCH",
  REJECTED: "SIGN-REJECTED-BY-USER",
} as const;
export type SigningReason = (typeof SIGNING_REASONS)[keyof typeof SIGNING_REASONS];

export class SigningError extends Error {
  constructor(readonly reason: SigningReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SigningError";
  }
}

export const calldataHashOf = (data: Hex): string => `sha256:${sha256Hex(data)}`;

/**
 * Prepare a request for signature.
 *
 * Simulation happens here, not in the caller, so there is no code path that produces a
 * SignatureRequest without one. A contract creation is simulated by estimating it — an estimate
 * that succeeds is a constructor that ran.
 */
export async function prepareForSignature(
  reader: ChainReader,
  req: Omit<SignatureRequest, "calldataHash">,
): Promise<SignatureRequest> {
  /*
   * The signer fence, before anything is prepared.
   *
   * A signature request is the last point at which a transaction is still hypothetical. Refusing a
   * production chain here means no wallet is ever asked, which matters because a wallet prompt for a
   * mainnet transaction is itself the failure — the user should never see one.
   */
  fenceWriteByChain("SIGNER", req.chainId);
  assertWalletChain(req.chainId, reader.chainId);
  try {
    if (req.to === null) {
      await reader.estimateGas({ from: req.from, data: req.data });
    } else {
      await reader.call({ from: req.from, to: req.to, data: req.data, value: BigInt(req.value) });
    }
  } catch (e) {
    throw new SigningError(
      SIGNING_REASONS.SIMULATION_REVERTED,
      `step "${req.deploymentStepId}" would fail before it is signed: ${(e as Error).message}`,
    );
  }
  return { ...req, calldataHash: calldataHashOf(req.data) };
}

/** The connected wallet must be the account the manifest named, and on the right chain. */
export function assertSignerMatches(req: SignatureRequest, connected: { address: Address; chainId: number }): void {
  if (connected.address.toLowerCase() !== req.from.toLowerCase()) {
    throw new SigningError(
      SIGNING_REASONS.WRONG_ACCOUNT,
      `step "${req.deploymentStepId}" must be signed by ${req.from}, but ${connected.address} is connected`,
    );
  }
  if (connected.chainId !== req.chainId) {
    throw new SigningError(
      SIGNING_REASONS.WRONG_CHAIN,
      `step "${req.deploymentStepId}" targets chain ${req.chainId}, but the wallet is on chain ${connected.chainId}`,
    );
  }
}

/** What the wallet actually signed must be what we prepared. */
export function assertSignedWhatWePlanned(req: SignatureRequest, signedData: Hex): void {
  const actual = calldataHashOf(signedData);
  if (actual !== req.calldataHash) {
    throw new SigningError(
      SIGNING_REASONS.CALLDATA_MISMATCH,
      `step "${req.deploymentStepId}": prepared ${req.calldataHash}, signed ${actual}`,
    );
  }
}
