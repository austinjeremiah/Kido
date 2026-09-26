import { decodeEventLog, parseAbi, toHex, type Hex } from "viem";
import { amaneDigest, destSpecHash, type ActionIntent, type AmaneEvmEndpoint, type AmaneOutcome, type AmaneSuiEndpoint, type DestSpec, type WormholeSuiRoute } from "@kido/amane-bridge";
import { CHAINS } from "@kido/registry";
import type { CrossChainIntent, Delivery, DestinationEndpoint, ReserveResult, Transport } from "@kido/runtime";

/**
 * Wormhole Token Bridge transport between Amane endpoints. The transport only moves funds and a
 * 64-byte commitment (source intent digest ‖ destination endpoint); every rule about what may
 * happen on arrival is enforced by the destination Amane account when it redeems the VAA.
 */

/** Signed authority a Wormhole-routed intent carries. The chain re-verifies all of it. */
export interface AmaneBridgeAuthority {
  src: ActionIntent;
  srcSig: Hex;
  dest: DestSpec;
}

/** Manifest-derived transport facts (Aname/deployments/testnet.json). */
export interface WormholeFacts {
  vaaApi: string;
  sui: { chainId: number; tokenBridgeEmitter: string; route: WormholeSuiRoute };
  evm: { chainId: number; core: `0x${string}`; tokenBridge: `0x${string}`; adapterId: Hex };
}

type Manifestish = { sui: any; evm: any };

/** Reads the transport facts from the Amane manifest plus the deployed bridge/adapter instances. */
export function wormholeFacts(m: Manifestish, instance: { suiBridge: string; evmAdapterId: Hex; coinType: string }): WormholeFacts {
  const W = m.sui.protocols?.wormhole ?? fail("manifest has no Sui Wormhole protocol entry");
  const WE = m.evm.protocols?.wormhole ?? fail("manifest has no EVM Wormhole protocol entry");
  const adapter = (m.sui.adapters as { name: string; core?: string; package: string }[]).find((a) => a.name === "Wormhole Bridge" && a.core) ?? fail("manifest has no Sui Wormhole adapter");
  return {
    vaaApi: WE.vaaApi,
    sui: { chainId: W.chainId, tokenBridgeEmitter: W.tokenBridgeEmitter, route: { adapterPackage: adapter.package, bridge: instance.suiBridge, coinType: instance.coinType, tokenBridge: { package: W.tokenBridgePackage, state: W.tokenBridgeState }, wormhole: { package: W.corePackage, state: W.coreState } } },
    evm: { chainId: WE.chainId, core: WE.core, tokenBridge: WE.tokenBridge, adapterId: instance.evmAdapterId },
  };
}

const family = (chain: string) => CHAINS.find((c) => c.chainId === chain)?.family ?? fail(`unknown chain ${chain}`);
const coreAbi = parseAbi(["event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)"]);
const pad32 = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** The Kido intent id of a Wormhole-routed intent is the Amane digest the payload carries. */
export function amaneIntentId(a: AmaneBridgeAuthority): Hex {
  if (a.src.planHash.toLowerCase() !== destSpecHash(a.dest).toLowerCase()) fail("source intent does not commit to this destination spec");
  return amaneDigest("ActionIntent", a.src);
}

export interface Endpoints {
  sui?: AmaneSuiEndpoint;
  evm?: AmaneEvmEndpoint;
}

export class WormholeAmaneTransport implements Transport {
  readonly id = "wormhole";
  constructor(
    private readonly endpoints: Endpoints,
    private readonly facts: WormholeFacts,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Executes the source Amane BRIDGE (the chain enforces lease, budget and pinned destination). */
  async send(i: CrossChainIntent): Promise<{ messageId: string; sourceTx: string }> {
    const a = i.authority as AmaneBridgeAuthority;
    if (family(i.source.chain) === "sui") {
      const ep = this.endpoints.sui ?? fail("no Sui endpoint");
      const out = must(await ep.bridgeOutWormhole(this.facts.sui.route, a.src, a.srcSig));
      const seq = await ep.wormholeSequence(out, this.facts.sui.tokenBridgeEmitter);
      return { messageId: `${this.facts.sui.chainId}/${pad32(this.facts.sui.tokenBridgeEmitter)}/${seq}`, sourceTx: out };
    }
    const ep = this.endpoints.evm ?? fail("no EVM endpoint");
    const out = must(await ep.executeAction(a.src, a.srcSig)) as Hex;
    const receipt = await ep.publicClient.getTransactionReceipt({ hash: out });
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.facts.evm.core.toLowerCase()) continue;
      const e = decodeEventLog({ abi: coreAbi, data: log.data, topics: log.topics });
      if (e.args.sender.toLowerCase() === this.facts.evm.tokenBridge.toLowerCase()) return { messageId: `${this.facts.evm.chainId}/${pad32(this.facts.evm.tokenBridge)}/${e.args.sequence}`, sourceTx: out };
    }
    return fail(`no Token Bridge message in ${out}`);
  }

  /** Signed VAA from the guardian network. Its contents are untrusted until the destination redeems it. */
  async poll(messageId: string) {
    const res = await this.fetchImpl(`${this.facts.vaaApi}/${messageId}`).catch(() => undefined);
    if (!res?.ok) return { status: "PENDING" as const };
    const body = (await res.json()) as { data?: { vaa?: string } };
    if (!body.data?.vaa) return { status: "PENDING" as const };
    const vaa = new Uint8Array(Buffer.from(body.data.vaa, "base64"));
    const t = parseTransferVaa(vaa);
    const byChainId = (id: number) => (id === this.facts.sui.chainId ? "sui-testnet" : id === this.facts.evm.chainId ? "ethereum-sepolia" : `wormhole:${id}`);
    const delivery: Delivery = {
      messageId,
      intentId: t.intent,
      sourceChain: byChainId(t.emitterChain),
      sourceAccount: t.fromAddress,
      destinationChain: byChainId(t.toChain),
      destinationAccount: t.destination,
      asset: t.tokenAddress,
      amount: t.amount,
      deliveredAt: Date.now(),
      proof: toHex(vaa),
    };
    return { status: "DELIVERED" as const, delivery };
  }
}

/**
 * The destination Amane account as the reservation authority: `reserve` redeems the VAA through
 * the pinned transport adapter, and the account re-checks the signed source intent, the DestSpec
 * it commits to, the lease, asset, minimum, deadline and replay before reserving the arrival.
 */
export class AmaneOnChainDestination implements DestinationEndpoint {
  readonly enforcement = "ON_CHAIN" as const;
  private readonly known = new Map<string, CrossChainIntent>();
  constructor(
    readonly chain: string,
    readonly account: string,
    private readonly endpoints: Endpoints,
    private readonly facts: WormholeFacts,
  ) {}

  expect(i: CrossChainIntent) {
    if (i.destination.chain !== this.chain) throw new Error("intent is not for this endpoint");
    this.known.set(i.intentId.toLowerCase(), i);
  }

  async reserve(d: Delivery): Promise<ReserveResult> {
    const i = this.known.get(d.intentId.toLowerCase());
    if (!i) return { ok: false, code: "UNKNOWN_INTENT" };
    const a = i.authority as AmaneBridgeAuthority;
    const out: AmaneOutcome =
      family(this.chain) === "sui"
        ? await (this.endpoints.sui ?? fail("no Sui endpoint")).redeemWormhole(this.facts.sui.route, hexBytes(d.proof), a.src, a.srcSig, a.dest)
        : await (this.endpoints.evm ?? fail("no EVM endpoint")).receiveCrossChain(a.src, a.srcSig, a.dest, this.facts.evm.adapterId, d.proof as Hex);
    if (out.kind !== "EXECUTED") return { ok: false, code: out.kind === "REJECTED_BY_AMANE" ? out.code : `${out.kind}: ${"message" in out ? out.message : ""}` };
    return {
      ok: true,
      tx: out.tx,
      reservation: { intentId: i.intentId, asset: a.dest.asset, amount: d.amount, action: i.destination.action, adapterId: a.dest.adapterId, beneficiary: a.dest.recipient, consumed: false },
    };
  }
}

/** Token Bridge transfer-with-payload VAA → the fields Kido reports (unverified). */
export function parseTransferVaa(vaa: Uint8Array) {
  const sigs = vaa[5]!;
  const body = 6 + sigs * 66;
  const view = new DataView(vaa.buffer, vaa.byteOffset, vaa.byteLength);
  const hex = (o: number, n: number) => toHex(vaa.slice(o, o + n));
  const p = body + 51; // timestamp 4, nonce 4, emitter chain 2, emitter 32, sequence 8, consistency 1
  if (vaa[p] !== 3) fail("not a transfer-with-payload VAA");
  const payload = p + 133;
  return {
    emitterChain: view.getUint16(body + 8),
    amount: BigInt(hex(p + 1, 32)),
    tokenAddress: hex(p + 33, 32),
    toChain: view.getUint16(p + 99),
    fromAddress: hex(p + 101, 32),
    intent: hex(payload, 32),
    destination: hex(payload + 32, 32),
  };
}

function hexBytes(h: string): Uint8Array {
  return new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
}

function must(o: AmaneOutcome): string {
  if (o.kind === "EXECUTED") return o.tx;
  throw new Error(o.kind === "REJECTED_BY_AMANE" ? `source endpoint refused: ${o.code}` : `source failed: ${o.kind}`);
}

function fail(msg: string): never {
  throw new Error(msg);
}
