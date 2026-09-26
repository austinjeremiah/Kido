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
  type DestSpec,
} from '@amane/core';
import { amaneAccountAbi, amaneAccountBytecode } from './evm-artifacts.js';
import { classifyCode, evmRejection, type AmaneOutcome } from './outcome.js';

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
    /** Shared AmaneAccountExt for this chain (from the manifest); required by core v3 accounts. */
    ext: Address;
  }): Promise<{ endpoint: AmaneEvmEndpoint; tx: Hex }> {
    const sorted = [...args.controllers].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const tx = await args.relayer.deployContract({
      abi: amaneAccountAbi,
      bytecode: amaneAccountBytecode,
      args: [args.accountId, sorted, args.threshold, args.registry, args.ext],
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

  /** Core release of this account: 2 enforces REPAY; accounts without the getter are v1. */
  async coreVersion(): Promise<number> {
    try {
      return Number(await this.publicClient.readContract({ address: this.address, abi: amaneAccountAbi, functionName: 'CORE_VERSION' }));
    } catch {
      return 1;
    }
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

  /** Redeems a cross-chain delivery through a pinned transport adapter and reserves it for its intent. */
  receiveCrossChain(src: ActionIntent, srcSig: Hex, dest: DestSpec, transportId: Bytes32, transportData: Hex, opts: { submitRejected?: boolean } = {}) {
    return this.send('receiveCrossChain', [src, srcSig, dest, transportId, transportData], opts);
  }

  /** Spends a reservation with the action its intent pinned. */
  executeReserved(intent: Bytes32, action: ActionIntent, agentSig: Hex, opts: { submitRejected?: boolean } = {}) {
    return this.send('executeReserved', [intent, action, agentSig], opts);
  }

  /** Destination-failure path: redeems an undeliverable arrival straight into quarantine. */
  recoverArrival(src: ActionIntent, srcSig: Hex, dest: DestSpec, transportId: Bytes32, transportData: Hex, opts: { submitRejected?: boolean } = {}) {
    return this.send('recoverArrival', [src, srcSig, dest, transportId, transportData], opts);
  }

  /** Moves an expired, unspent reservation into quarantine. */
  releaseReservation(intent: Bytes32, opts: { submitRejected?: boolean } = {}) {
    return this.send('releaseReservation', [intent], opts);
  }

  /** (locked for ordinary actions, of which quarantined) for one token. */
  async locked(token: Address): Promise<{ reserved: bigint; quarantined: bigint }> {
    const read = (functionName: 'reservedOf' | 'quarantinedOf') =>
      this.publicClient.readContract({ address: this.address, abi: amaneAccountAbi, functionName, args: [token] }) as Promise<bigint>;
    const [reserved, quarantined] = await Promise.all([read('reservedOf'), read('quarantinedOf')]);
    return { reserved, quarantined };
  }

  async reservation(intent: Bytes32): Promise<{ remaining: bigint; deadline: bigint }> {
    const r = (await this.publicClient.readContract({ address: this.address, abi: amaneAccountAbi, functionName: 'reservations', args: [intent] })) as readonly unknown[];
    return { deadline: r[5] as bigint, remaining: r[6] as bigint };
  }

  executeAction(intent: ActionIntent, agentSig: Hex, opts: { submitRejected?: boolean } = {}) {
    return this.send('executeAction', [intent, agentSig], opts);
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
  /// A transaction that passed simulation but reverted on inclusion (a pause, revoke or competing
  /// relayer landed first) is re-simulated to recover its code.
  async send(functionName: string, args: unknown[], opts: { submitRejected?: boolean } = {}): Promise<AmaneOutcome> {
    const call = { address: this.address, abi: amaneAccountAbi, functionName, args, account: this.relayer.account } as never;
    try {
      const { request } = await this.publicClient.simulateContract(call);
      const tx = await this.relayer.writeContract(request as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status === 'success') return { kind: 'EXECUTED', chain: this.chain, tx, block: receipt.blockNumber.toString() };
      const code = await this.simulatedRejection(call);
      if (code) return classifyCode(this.chain, code, tx);
      return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: 'reverted on inclusion without an Amane code', tx };
    } catch (err) {
      const code = evmRejection(err);
      if (code && opts.submitRejected) return this.submitRejected(functionName, args, code);
      if (code) return classifyCode(this.chain, code);
      return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: (err as Error).message.split('\n')[0]! };
    }
  }

  private async simulatedRejection(call: never): Promise<string | undefined> {
    try {
      await this.publicClient.simulateContract(call);
      return undefined;
    } catch (err) {
      return evmRejection(err);
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
    return classifyCode(this.chain, code, tx);
  }
}
