import { ContractFunctionRevertedError } from 'viem';
import { amaneCodeName } from '@amane/core';

export type Chain = 'ethereum-sepolia' | 'sui-testnet';

/// A policy rejection is a successful deterministic security outcome; an RPC or gas failure is an
/// operational failure. The two are never collapsed into one "denied" state.
///
/// NONCE_CONSUMED means the signed intent's nonce is already used on-chain: this intent can never
/// execute again, but whether *this* intent (or another one reusing the nonce) executed must be
/// settled from chain events. Callers must never treat it as success or as a retryable failure.
export type AmaneOutcome =
  | { kind: 'EXECUTED'; chain: Chain; tx: string; block?: string }
  | { kind: 'REJECTED_BY_AMANE'; chain: Chain; code: string; tx?: string }
  | { kind: 'NONCE_CONSUMED'; chain: Chain; tx?: string }
  | { kind: 'OPERATIONAL_FAILURE'; chain: Chain; message: string; tx?: string };

// Codes that describe funding or token behaviour rather than a policy decision.
const OPERATIONAL_CODES = new Set(['AMANE_OWNER_INSUFFICIENT_VAULT', 'AMANE_ASSET_TRANSFER_FAILED', 'AMANE_ASSET_NOT_A_TOKEN']);

export function classifyCode(chain: Chain, code: string, tx?: string): AmaneOutcome {
  if (code === 'AMANE_REPLAY_NONCE') return { kind: 'NONCE_CONSUMED', chain, ...(tx ? { tx } : {}) };
  if (OPERATIONAL_CODES.has(code)) return { kind: 'OPERATIONAL_FAILURE', chain, message: code, ...(tx ? { tx } : {}) };
  return { kind: 'REJECTED_BY_AMANE', chain, code, ...(tx ? { tx } : {}) };
}

export function suiAbortName(code: number | string): string | undefined {
  return amaneCodeName(code);
}

const EVM_SIG_ERRORS: Record<string, string> = {
  BadSignatureLength: 'AMANE_CONTROLLER_BAD_SIGNATURE_LENGTH',
  BadV: 'AMANE_CONTROLLER_BAD_V',
  HighS: 'AMANE_CONTROLLER_HIGH_S',
  ZeroRS: 'AMANE_CONTROLLER_ZERO_RS',
  RecoverFailed: 'AMANE_CONTROLLER_BAD_SIGNATURE',
};

interface RevertLike {
  name?: string;
  data?: { errorName?: string; args?: readonly unknown[] };
  cause?: unknown;
}

// Matched by shape, not `instanceof`: the caller's viem clients may come from a different copy of
// viem than this SDK's, and a class check across copies silently misclassifies every revert.
function findRevert(err: unknown): RevertLike | undefined {
  for (let e = err as RevertLike | undefined, depth = 0; e && depth < 12; e = e.cause as RevertLike | undefined, depth++) {
    if (e.name === 'ContractFunctionRevertedError' || e instanceof ContractFunctionRevertedError) return e;
  }
  return undefined;
}

export function evmRejection(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const revert = findRevert(err);
  if (!revert?.data?.errorName) return undefined;
  if (revert.data.errorName === 'AmaneRejected') return amaneCodeName(revert.data.args?.[0] as number) ?? `AMANE_CODE_${String(revert.data.args?.[0])}`;
  return EVM_SIG_ERRORS[revert.data.errorName];
}
