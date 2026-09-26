import type { Account, Address, Chain as ViemChain, Hex, PublicClient, Transport, WalletClient } from 'viem';
import {
  addressToBytes32,
  type ActionIntent,
  type AgentLease,
  type Bytes32,
  type PauseAccount,
  type RevokeLease,
  type RootPolicy,
  type UnpauseAccount,
  type Withdraw,
} from '@amane/core';
import { amaneAccountAbi, amaneAccountBytecode } from './evm-artifacts.js';
import { evmRejection, type AmaneOutcome } from './outcome.js';

type Wallet = WalletClient<Transport, ViemChain, Account>;

export interface EvmEndpointState {
  accountId: Bytes32;
  chainRef: Bytes32;
  policyVersion: bigint;
  policyHash: Bytes32;
  paused: boolean;
  pauseEpoch: bigint;
  lastPauseId: Bytes32;
  opNonce: bigint;
  controllers: readonly Address[];
}

/// Relays signed Amane messages to one EVM account endpoint. The wallet here is a gas-paying
/// relayer only; it holds no authority over the account.
export class AmaneEvmEndpoint {
  readonly chain = 'ethereum-sepolia' as const;

  constructor(
    readonly publicClient: PublicClient,
    readonly relayer: Wallet,
    readonly address: Address,
  ) {}

  static async deploy(args: {
    publicClient: PublicClient;
    relayer: Wallet;
    accountId: Bytes32;
    controllers: Address[];
    threshold: number;
    registry: Address;
  }): Promise<{ endpoint: AmaneEvmEndpoint; tx: Hex }> {
    const sorted = [...args.controllers].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const tx = await args.relayer.deployContract({
      abi: amaneAccountAbi,
      bytecode: amaneAccountBytecode,
      args: [args.accountId, sorted, args.threshold, args.registry],
    });
    const receipt = await args.publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`account deployment failed: ${tx}`);
    return { endpoint: new AmaneEvmEndpoint(args.publicClient, args.relayer, receipt.contractAddress), tx };
  }

  get account32(): Bytes32 {
    return addressToBytes32(this.address);
  }

  async state(): Promise<EvmEndpointState> {
    const read = <T>(functionName: string) =>
      this.publicClient.readContract({ address: this.address, abi: amaneAccountAbi, functionName } as never) as Promise<T>;
    const [accountId, chainRef, policyVersion, policyHash, paused, pauseEpoch, lastPauseId, opNonce, controllers] = await Promise.all([
      read<Bytes32>('accountId'),
      read<Bytes32>('chainRef'),
      read<bigint>('policyVersion'),
      read<Bytes32>('policyHash'),
      read<boolean>('paused'),
      read<bigint>('pauseEpoch'),
      read<Bytes32>('lastPauseId'),
      read<bigint>('opNonce'),
      read<readonly Address[]>('controllers'),
    ]);
    return { accountId, chainRef, policyVersion, policyHash, paused, pauseEpoch, lastPauseId, opNonce, controllers };
  }

  async leaseStatus(leaseId: Bytes32): Promise<number> {
    const l = (await this.publicClient.readContract({ address: this.address, abi: amaneAccountAbi, functionName: 'lease', args: [leaseId] })) as {
      status: number;
    };
    return l.status;
  }

  async nonceUsed(leaseId: Bytes32, nonce: bigint): Promise<boolean> {
    return this.publicClient.readContract({ address: this.address, abi: amaneAccountAbi, functionName: 'nonceUsed', args: [leaseId, nonce] });
  }

  installPolicy(policy: RootPolicy, sigs: Hex[]) {
    return this.send('installPolicy', [policy, sigs]);
  }

  activateLease(lease: AgentLease, sig: Hex) {
    return this.send('activateLease', [lease, sig]);
  }

  executeAction(intent: ActionIntent, agentSig: Hex) {
    return this.send('executeAction', [intent, agentSig]);
  }

  pause(msg: PauseAccount, sig: Hex) {
    return this.send('pause', [msg, sig]);
  }

  unpause(msg: UnpauseAccount, sigs: Hex[]) {
    return this.send('unpause', [msg, sigs]);
  }

  revokeLease(msg: RevokeLease, sig: Hex) {
    return this.send('revokeLease', [msg, sig]);
  }

  withdraw(msg: Withdraw, sigs: Hex[]) {
    return this.send('withdraw', [msg, sigs]);
  }

  /// Simulates first so a policy rejection is reported with its Amane code and never spends gas.
  async send(functionName: string, args: unknown[], opts: { submitRejected?: boolean } = {}): Promise<AmaneOutcome> {
    try {
      const { request } = await this.publicClient.simulateContract({
        address: this.address,
        abi: amaneAccountAbi,
        functionName,
        args,
        account: this.relayer.account,
      } as never);
      const tx = await this.relayer.writeContract(request as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== 'success') return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: 'reverted after simulation', tx };
      return { kind: 'EXECUTED', chain: this.chain, tx, block: receipt.blockNumber.toString() };
    } catch (err) {
      const code = evmRejection(err);
      if (code && opts.submitRejected) return this.submitRejected(functionName, args, code);
      if (code) return { kind: 'REJECTED_BY_AMANE', chain: this.chain, code };
      return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: (err as Error).message.split('\n')[0]! };
    }
  }

  /// Lands a rejected call on-chain (with a fixed gas limit) so the rejection has a receipt.
  private async submitRejected(functionName: string, args: unknown[], code: string): Promise<AmaneOutcome> {
    const tx = await this.relayer.writeContract({
      address: this.address,
      abi: amaneAccountAbi,
      functionName,
      args,
      gas: 1_500_000n,
    } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status === 'success') return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: 'expected rejection but succeeded', tx };
    return { kind: 'REJECTED_BY_AMANE', chain: this.chain, code, tx };
  }
}
