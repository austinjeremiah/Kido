// BREAK: outcome classification under adversarial RPC / executor conditions.
// break_* cases assert the secure behaviour and fail while their finding is open.
import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { AMANE_CODES, fixtureAction } from '@amane/core';
import { AmaneEvmEndpoint, AmaneSuiEndpoint, amaneAccountAbi } from '../src/index.js';

const ACCOUNT = '0x00000000000000000000000000000000000a3a7e' as const;
const relayer = privateKeyToAccount(keccak256(new TextEncoder().encode('amane.test-only.relayer')));
const EXEC_SEL = toFunctionSelector(amaneAccountAbi.find((x) => x.type === 'function' && x.name === 'executeAction') as never);
const NONCE_SEL = toFunctionSelector(amaneAccountAbi.find((x) => x.type === 'function' && x.name === 'nonceUsed') as never);
const amaneRevert = (code: number) => encodeErrorResult({ abi: amaneAccountAbi, errorName: 'AmaneRejected', args: [code] } as never);

class RpcRevert extends Error {
  code = 3;
  constructor(readonly data: Hex) {
    super('execution reverted');
  }
}

interface Script {
  /// eth_call for executeAction: n-th call (0-based) → revert data or undefined for success.
  execCall: (n: number) => Hex | undefined;
  receiptStatus: '0x1' | '0x0';
  nonceUsed: boolean;
}

function evmEndpoint(script: Script) {
  let execCalls = 0;
  let sent = 0;
  const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    switch (method) {
      case 'eth_chainId':
        return '0xaa36a7';
      case 'eth_blockNumber':
        return '0x10';
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_estimateGas':
        return '0x100000';
      case 'eth_maxPriorityFeePerGas':
      case 'eth_gasPrice':
        return '0x1';
      case 'eth_getBlockByNumber':
        return { number: '0x10', baseFeePerGas: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x0', transactions: [] };
      case 'eth_call': {
        const data = (params![0] as { data?: Hex; input?: Hex }).data ?? (params![0] as { input: Hex }).input;
        if (data.startsWith(NONCE_SEL)) return encodeAbiParameters([{ type: 'bool' }], [script.nonceUsed]);
        if (data.startsWith(EXEC_SEL)) {
          const r = script.execCall(execCalls++);
          if (r) throw new RpcRevert(r);
          return encodeFunctionResult({ abi: amaneAccountAbi, functionName: 'executeAction', result: 1n } as never);
        }
        throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
      }
      case 'eth_sendRawTransaction':
        sent++;
        return keccak256(params![0] as Hex);
      case 'eth_getTransactionReceipt':
        return {
          transactionHash: `0x${'22'.repeat(32)}`,
          transactionIndex: '0x0',
          blockHash: `0x${'11'.repeat(32)}`,
          blockNumber: '0x10',
          from: relayer.address,
          to: ACCOUNT,
          cumulativeGasUsed: '0x1',
          gasUsed: '0x1',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: script.receiptStatus,
          type: '0x2',
        };
      case 'eth_getTransactionByHash':
        return null;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const transport = custom({ request } as never);
  const publicClient = createPublicClient({ chain: sepolia, transport, pollingInterval: 1 });
  const wallet = createWalletClient({ chain: sepolia, transport, account: relayer });
  return { ep: new AmaneEvmEndpoint(publicClient as never, wallet as never, ACCOUNT), sent: () => sent };
}

describe('EVM outcome classification', () => {
  it('holds: simulated Amane rejection is classified with its code and nothing is sent', async () => {
    const { ep, sent } = evmEndpoint({ execCall: () => amaneRevert(AMANE_CODES.AMANE_LEASE_NOT_ACTIVE), receiptStatus: '0x1', nonceUsed: false });
    const out = await ep.executeAction(fixtureAction(), '0x');
    expect(out).toMatchObject({ kind: 'REJECTED_BY_AMANE', code: 'AMANE_LEASE_NOT_ACTIVE' });
    expect(sent()).toBe(0);
  });

  it('holds: a non-Amane revert is an operational failure', async () => {
    const { ep } = evmEndpoint({ execCall: () => '0xdeadbeef', receiptStatus: '0x1', nonceUsed: false });
    const out = await ep.executeAction(fixtureAction(), '0x');
    expect(out.kind).toBe('OPERATIONAL_FAILURE');
  });

  // F-0230: the signed action is front-run by another relayer (executors are untrusted and hold
  // the signature). Our tx lands after it and reverts with REPLAY_NONCE; the action DID execute.
  it('fixed_F0230 front-run action reported as operational failure although it executed', async () => {
    const { ep } = evmEndpoint({
      execCall: (n) => (n === 0 ? undefined : amaneRevert(AMANE_CODES.AMANE_REPLAY_NONCE)),
      receiptStatus: '0x0',
      nonceUsed: true,
    });
    const out = await ep.executeAction(fixtureAction(), '0x');
    // Secure: the SDK must not report a failure for an action whose nonce is consumed on-chain.
    expect(out.kind).not.toBe('OPERATIONAL_FAILURE');
    expect(out.kind === 'REJECTED_BY_AMANE' && out.code === 'AMANE_REPLAY_NONCE').toBe(false);
  });

  // F-0231: a pause/revoke lands between simulation and inclusion. The on-chain revert is a policy
  // rejection (ACTION_ACCOUNT_PAUSED) but is reported as an operational failure without a code.
  it('fixed_F0231 on-chain policy rejection after simulation reported as operational failure', async () => {
    const { ep } = evmEndpoint({
      execCall: (n) => (n === 0 ? undefined : amaneRevert(AMANE_CODES.AMANE_ACTION_ACCOUNT_PAUSED)),
      receiptStatus: '0x0',
      nonceUsed: false,
    });
    const out = await ep.executeAction(fixtureAction(), '0x');
    expect(out).toMatchObject({ kind: 'REJECTED_BY_AMANE', code: 'AMANE_ACTION_ACCOUNT_PAUSED' });
  });
});

describe('EVM rejection evidence', () => {
  // F-0234: a REJECTED_BY_AMANE outcome for executeAction rests only on one eth_call answer from
  // the configured RPC. executeAction cannot request submitRejected, so a censoring RPC/executor
  // can make censorship look like a deterministic policy rejection with no on-chain evidence.
  it('fixed_F0234 executeAction rejection has no on-chain evidence and cannot request it', async () => {
    const { ep, sent } = evmEndpoint({ execCall: () => amaneRevert(AMANE_CODES.AMANE_LEASE_NOT_ACTIVE), receiptStatus: '0x0', nonceUsed: false });
    const out = await (ep.executeAction as (...a: unknown[]) => Promise<{ kind: string; tx?: string }>)(fixtureAction(), '0x', { submitRejected: true });
    expect(out.kind).toBe('REJECTED_BY_AMANE');
    expect(sent()).toBe(1); // a rejection that is reported must be backed by a landed receipt
    expect(out.tx).toBeDefined();
  });
});

// ------------------------------------------------------------------ Sui

const PKG = `0x${'5a'.repeat(32)}`;
const OBJ = `0x${'0b'.repeat(32)}`;

function suiEndpoint(sim: unknown, exec: unknown) {
  let executed = 0;
  const client = {
    simulateTransaction: async () => sim,
    signAndExecuteTransaction: async () => {
      executed++;
      return exec;
    },
    waitForTransaction: async () => ({}),
  };
  const signer = { toSuiAddress: () => `0x${'ee'.repeat(32)}` };
  return { ep: new AmaneSuiEndpoint(client as never, PKG, OBJ, signer as never), executed: () => executed };
}

const abort = (code: number, pkg?: string) => ({
  success: false,
  error: { MoveAbort: { abortCode: String(code), ...(pkg ? { location: { package: pkg, module: 'account' } } : {}) } },
});

describe('Sui outcome classification', () => {
  it('holds: abort from a foreign package is operational', async () => {
    const { ep } = suiEndpoint({ FailedTransaction: { status: abort(1304, `0x${'77'.repeat(32)}`) } }, undefined);
    const out = await ep.run(new (await import('@mysten/sui/transactions')).Transaction());
    expect(out.kind).toBe('OPERATIONAL_FAILURE');
  });

  it('fixed_F0230 sui front-run action reported as rejected although it executed', async () => {
    const { ep } = suiEndpoint(
      { Transaction: { digest: 'sim' } },
      { FailedTransaction: { digest: 'D1', status: abort(AMANE_CODES.AMANE_REPLAY_NONCE, PKG) } },
    );
    const out = await ep.run(new (await import('@mysten/sui/transactions')).Transaction());
    expect(out.kind === 'REJECTED_BY_AMANE' && out.code === 'AMANE_REPLAY_NONCE').toBe(false);
  });

  // F-0232: an abort with no location package is attributed to Amane even though its origin is
  // unknown (e.g. an adapter or upstream protocol aborting with a colliding number).
  it('fixed_F0232 abort without location is attributed to Amane', async () => {
    const { ep } = suiEndpoint({ FailedTransaction: { status: abort(AMANE_CODES.AMANE_BUDGET_EPOCH) } }, undefined);
    const out = await ep.run(new (await import('@mysten/sui/transactions')).Transaction());
    expect(out.kind).toBe('OPERATIONAL_FAILURE');
  });

  // F-0233: an underfunded vault is a funding/operational condition (EVM reports it as an
  // operational token revert) but Sui reports it as a policy rejection.
  it('fixed_F0233 underfunded sui vault classified as policy rejection', async () => {
    const { ep } = suiEndpoint({ FailedTransaction: { status: abort(AMANE_CODES.AMANE_OWNER_INSUFFICIENT_VAULT, PKG) } }, undefined);
    const out = await ep.run(new (await import('@mysten/sui/transactions')).Transaction());
    expect(out.kind).toBe('OPERATIONAL_FAILURE');
  });
});

describe('cross-copy viem errors', () => {
  it('a revert thrown by a different viem copy is still decoded to its Amane code', async () => {
    const { evmRejection } = await import('../src/outcome.js');
    const foreign = { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError', data: { errorName: 'AmaneRejected', args: [AMANE_CODES.AMANE_ACTION_RECIPIENT_NOT_ALLOWED] } } };
    expect(evmRejection(foreign)).toBe('AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
  });
});
