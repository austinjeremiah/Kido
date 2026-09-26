import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import {
  AMANE_TYPES,
  suiObjectToBytes32,
  type ActionIntent,
  type AgentLease,
  type Bytes32,
  type PauseAccount,
  type RevokeLease,
  type RootPolicy,
  type UnpauseAccount,
  type Withdraw,
} from '@amane/core';
import { classifyCode, suiAbortName, type AmaneOutcome } from './outcome.js';

type Field = { name: string; type: string };
const TYPES = AMANE_TYPES as unknown as Record<string, readonly Field[]>;
const CLOCK = '0x6';
const snake = (s: string) => s.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
const bytes = (h: string) => Array.from(hexToBytes(h as Hex));
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

/// Relays signed Amane messages to one Sui account object. The signer only pays gas.
export class AmaneSuiEndpoint {
  readonly chain = 'sui-testnet' as const;

  constructor(
    readonly client: SuiGrpcClient,
    readonly packageId: string,
    readonly objectId: string,
    readonly relayer: Signer,
  ) {}

  static async create(args: {
    client: SuiGrpcClient;
    packageId: string;
    relayer: Signer;
    accountId: Bytes32;
    chainRef: Bytes32;
    controllers: Hex[];
    threshold: number;
  }): Promise<{ endpoint: AmaneSuiEndpoint; tx: string }> {
    const sorted = [...args.controllers].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const tx = new Transaction();
    tx.moveCall({
      target: `${args.packageId}::account::create`,
      arguments: [
        tx.pure.vector('u8', bytes(args.accountId)),
        tx.pure.vector('u8', bytes(args.chainRef)),
        tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(sorted.map(bytes))),
        tx.pure.u8(args.threshold),
      ],
    });
    const res = await args.client.signAndExecuteTransaction({ transaction: tx, signer: args.relayer, include: { effects: true, objectTypes: true } });
    const done = res.Transaction ?? res.FailedTransaction;
    if (!res.Transaction) throw new Error(`account creation failed: ${done?.digest}`);
    const type = `${args.packageId}::account::Account`;
    const created = done!.effects!.changedObjects.find((o) => o.idOperation === 'Created' && done!.objectTypes?.[o.objectId] === type);
    if (!created) throw new Error('account object not found in effects');
    await args.client.waitForTransaction({ digest: done!.digest });
    return { endpoint: new AmaneSuiEndpoint(args.client, args.packageId, created.objectId, args.relayer), tx: done!.digest };
  }

  get account32(): Bytes32 {
    return suiObjectToBytes32(this.objectId);
  }

  // ---------------------------------------------------------------- struct builders

  private build(tx: Transaction, type: string, value: unknown): TransactionArgument {
    const fields = TYPES[type]!;
    const args = fields.map((f) => this.buildField(tx, f.type, (value as Record<string, unknown>)[f.name]));
    return tx.moveCall({ target: `${this.packageId}::eip712::${snake(type)}`, arguments: args });
  }

  private buildField(tx: Transaction, type: string, v: unknown): TransactionArgument {
    if (type.endsWith('[]')) {
      const inner = type.slice(0, -2);
      const arr = v as unknown[];
      if (TYPES[inner]) {
        return tx.makeMoveVec({ type: `${this.packageId}::eip712::${inner}`, elements: arr.map((x) => this.build(tx, inner, x)) });
      }
      return tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(arr.map((x) => bytes(x as string))));
    }
    if (TYPES[type]) return this.build(tx, type, v);
    switch (type) {
      case 'string':
        return tx.pure.vector('u8', utf8(v as string));
      case 'bytes32':
      case 'address':
        return tx.pure.vector('u8', bytes(v as string));
      case 'uint8':
        return tx.pure.u8(Number(v));
      case 'uint32':
        return tx.pure.u32(Number(v));
      case 'uint64':
        return tx.pure.u64(BigInt(v as bigint));
      default:
        return tx.pure.u256(BigInt(v as bigint));
    }
  }

  private sigs(tx: Transaction, sigs: Hex[]) {
    return tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(sigs.map(bytes)));
  }

  // ---------------------------------------------------------------- operations

  installPolicy(policy: RootPolicy, sigs: Hex[]) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::install_policy`,
      arguments: [tx.object(this.objectId), this.build(tx, 'RootPolicy', policy), this.sigs(tx, sigs), tx.object(CLOCK)],
    });
    return this.run(tx);
  }

  activateLease(lease: AgentLease, sig: Hex) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::activate_lease`,
      arguments: [tx.object(this.objectId), this.build(tx, 'AgentLease', lease), tx.pure.vector('u8', bytes(sig)), tx.object(CLOCK)],
    });
    return this.run(tx);
  }

  pay(coinType: string, intent: ActionIntent, agentSig: Hex, opts: { submitRejected?: boolean } = {}) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::pay`,
      typeArguments: [coinType],
      arguments: [tx.object(this.objectId), this.build(tx, 'ActionIntent', intent), tx.pure.vector('u8', bytes(agentSig)), tx.object(CLOCK)],
    });
    return this.run(tx, opts);
  }

  /// SWAP through a Cetus CLMM pool: the core authorizes the intent into a ticket typed by the
  /// adapter witness, and the adapter swaps and settles it in the same transaction.
  swapCetus(
    route: { adapterPackage: string; module?: string; witnessType?: string; coinA: string; coinB: string; a2b: boolean; pool: string; globalConfig: string },
    intent: ActionIntent,
    agentSig: Hex,
    opts: { submitRejected?: boolean } = {},
  ) {
    const tx = new Transaction();
    const mod = route.module ?? 'cetus_swap';
    const witness = route.witnessType ?? `${route.adapterPackage}::${mod}::CetusSwapV1`;
    const ticket = tx.moveCall({
      target: `${this.packageId}::account::authorize`,
      typeArguments: [witness, route.a2b ? route.coinA : route.coinB],
      arguments: [tx.object(this.objectId), this.build(tx, 'ActionIntent', intent), tx.pure.vector('u8', bytes(agentSig)), tx.object(CLOCK)],
    });
    tx.moveCall({
      target: `${route.adapterPackage}::${mod}::${route.a2b ? 'swap_a2b' : 'swap_b2a'}`,
      typeArguments: [route.coinA, route.coinB],
      arguments: [tx.object(this.objectId), ticket, tx.object(route.globalConfig), tx.object(route.pool), tx.object(CLOCK)],
    });
    return this.run(tx, opts);
  }

  pause(msg: PauseAccount, sig: Hex) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::pause`,
      arguments: [tx.object(this.objectId), this.build(tx, 'PauseAccount', msg), tx.pure.vector('u8', bytes(sig)), tx.object(CLOCK)],
    });
    return this.run(tx);
  }

  unpause(msg: UnpauseAccount, sigs: Hex[]) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::unpause`,
      arguments: [tx.object(this.objectId), this.build(tx, 'UnpauseAccount', msg), this.sigs(tx, sigs), tx.object(CLOCK)],
    });
    return this.run(tx);
  }

  revokeLease(msg: RevokeLease, sig: Hex) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::revoke_lease`,
      arguments: [tx.object(this.objectId), this.build(tx, 'RevokeLease', msg), tx.pure.vector('u8', bytes(sig))],
    });
    return this.run(tx);
  }

  withdraw(coinType: string, msg: Withdraw, sigs: Hex[]) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::account::withdraw`,
      typeArguments: [coinType],
      arguments: [tx.object(this.objectId), this.build(tx, 'Withdraw', msg), this.sigs(tx, sigs), tx.object(CLOCK)],
    });
    return this.run(tx);
  }

  /// Mints demo tokens from an open testnet faucet straight into the vault.
  depositFromFaucet(tokenPackage: string, module: string, coinType: string, faucet: string, amount: bigint) {
    const tx = new Transaction();
    const coin = tx.moveCall({ target: `${tokenPackage}::${module}::mint`, arguments: [tx.object(faucet), tx.pure.u64(amount)] });
    tx.moveCall({ target: `${this.packageId}::account::deposit`, typeArguments: [coinType], arguments: [tx.object(this.objectId), coin] });
    return this.run(tx);
  }

  // ---------------------------------------------------------------- views

  private async view(fn: string, args: (tx: Transaction) => TransactionArgument[], typeArguments: string[] = []): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(this.relayer.toSuiAddress());
    tx.moveCall({ target: `${this.packageId}::account::${fn}`, typeArguments, arguments: [tx.object(this.objectId), ...args(tx)] });
    const res = await this.client.simulateTransaction({ transaction: tx, include: { commandResults: true } });
    const out = res.Transaction ?? res.FailedTransaction;
    if (!res.Transaction) throw new Error(`view ${fn} failed: ${JSON.stringify(out?.status)}`);
    return res.commandResults![0]!.returnValues[0]!.bcs;
  }

  async policyVersion(): Promise<bigint> {
    return BigInt(bcs.u64().parse(await this.view('policy_version', () => [])));
  }

  async isPaused(): Promise<boolean> {
    return bcs.bool().parse(await this.view('is_paused', () => []));
  }

  async pauseEpoch(): Promise<bigint> {
    return BigInt(bcs.u64().parse(await this.view('pause_epoch', () => [])));
  }

  async lastPauseId(): Promise<Hex> {
    const v = bcs.vector(bcs.u8()).parse(await this.view('last_pause_id', () => []));
    return bytesToHex(new Uint8Array(v));
  }

  async policyHash(): Promise<Hex> {
    const v = bcs.vector(bcs.u8()).parse(await this.view('policy_hash', () => []));
    return v.length ? bytesToHex(new Uint8Array(v)) : (`0x${'00'.repeat(32)}` as Hex);
  }

  async leaseStatus(leaseId: Bytes32): Promise<number> {
    return bcs.u8().parse(await this.view('lease_status', (tx) => [tx.pure.vector('u8', bytes(leaseId))]));
  }

  async vaultBalance(coinType: string): Promise<bigint> {
    return BigInt(bcs.u64().parse(await this.view('vault_balance', () => [], [coinType])));
  }

  // ---------------------------------------------------------------- execution

  /// Simulates first so a policy rejection is reported with its Amane code. With
  /// `submitRejected`, the rejected transaction is also landed on-chain for a receipt.
  async run(tx: Transaction, opts: { submitRejected?: boolean } = {}): Promise<AmaneOutcome> {
    tx.setSender(this.relayer.toSuiAddress());
    try {
      const sim = await this.client.simulateTransaction({ transaction: tx, include: { effects: true } });
      if (!sim.Transaction) {
        const code = this.abortCode(sim.FailedTransaction!.status);
        if (!code) return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: JSON.stringify(sim.FailedTransaction!.status) };
        if (!opts.submitRejected) return classifyCode(this.chain, code);
        return await this.landRejected(tx);
      }
      const res = await this.client.signAndExecuteTransaction({ transaction: tx, signer: this.relayer, include: { effects: true, events: true } });
      return await this.settle(res);
    } catch (err) {
      const message = (err as Error).message.split('\n')[0]!;
      const code = this.abortCodeFromMessage(message);
      if (code) return classifyCode(this.chain, code);
      return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message };
    }
  }

  private async settle(res: Awaited<ReturnType<SuiGrpcClient['executeTransaction']>>): Promise<AmaneOutcome> {
    const done = res.Transaction ?? res.FailedTransaction!;
    await this.client.waitForTransaction({ digest: done.digest });
    if (res.Transaction) return { kind: 'EXECUTED', chain: this.chain, tx: done.digest };
    const code = this.abortCode(done.status);
    if (code) return classifyCode(this.chain, code, done.digest);
    return { kind: 'OPERATIONAL_FAILURE', chain: this.chain, message: JSON.stringify(done.status), tx: done.digest };
  }

  /// The client's resolver refuses to build a transaction whose simulation aborts, so a rejected
  /// action is built as a transaction kind (checks disabled), completed with a pinned gas
  /// configuration, and executed from raw bytes. Validators accept it and record the abort.
  private async landRejected(tx: Transaction): Promise<AmaneOutcome> {
    const kind = await tx.build({ client: this.client, onlyTransactionKind: true });
    const full = Transaction.fromKind(kind);
    full.setSender(this.relayer.toSuiAddress());
    await this.pinGas(full);
    const bytes = await full.build();
    const { signature } = await this.relayer.signTransaction(bytes);
    return this.settle(await this.client.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true } }));
  }

  private async pinGas(tx: Transaction) {
    const owner = this.relayer.toSuiAddress();
    const [{ referenceGasPrice }, coins] = await Promise.all([this.client.getReferenceGasPrice(), this.client.listCoins({ owner, limit: 1 })]);
    const coin = coins.objects[0];
    if (!coin) throw new Error('relayer has no SUI gas coin');
    tx.setGasPrice(BigInt(referenceGasPrice));
    tx.setGasBudget(50_000_000);
    tx.setGasPayment([{ objectId: coin.objectId, version: coin.version, digest: coin.digest }]);
  }

  private abortCodeFromMessage(message: string): string | undefined {
    const m = /abort code: (\d+), in '(0x[0-9a-fA-F]+)::/.exec(message);
    if (!m || suiObjectToBytes32(m[2]!) !== suiObjectToBytes32(this.packageId)) return undefined;
    return suiAbortName(m[1]!);
  }

  private abortCode(status: { success: boolean; error?: unknown }): string | undefined {
    const e = status.error as { MoveAbort?: { abortCode: string; location?: { package?: string } } } | null;
    const abort = e?.MoveAbort;
    if (!abort) return undefined;
    const pkg = abort.location?.package;
    if (!pkg || suiObjectToBytes32(pkg) !== suiObjectToBytes32(this.packageId)) return undefined;
    return suiAbortName(abort.abortCode);
  }
}
