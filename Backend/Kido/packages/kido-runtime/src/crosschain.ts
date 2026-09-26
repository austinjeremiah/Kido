import { keccak256, toHex } from "viem";
import type { EventLog } from "./events.js";

/**
 * Generic cross-chain state machine (bible §43). Transport proves delivery; it never defines
 * financial authority. The destination independently checks every field the intent pins before
 * the arrived funds are reserved for that intent, and only the pinned destination action may
 * consume the reservation.
 */
export type CrossChainState =
  | "CREATED"
  | "SOURCE_AUTHORIZED"
  | "SOURCE_COMMITTED"
  | "IN_FLIGHT"
  | "ARRIVED"
  | "RESERVED"
  | "DESTINATION_AUTHORIZED"
  | "SETTLED"
  | "COMPLETE"
  | "TIMED_OUT"
  | "DESTINATION_FAILED"
  | "RECOVERY_REQUIRED"
  | "RECOVERED";

const NEXT: Record<CrossChainState, CrossChainState[]> = {
  CREATED: ["SOURCE_AUTHORIZED"],
  SOURCE_AUTHORIZED: ["SOURCE_COMMITTED"],
  SOURCE_COMMITTED: ["IN_FLIGHT"],
  IN_FLIGHT: ["ARRIVED", "TIMED_OUT"],
  ARRIVED: ["RESERVED", "DESTINATION_FAILED"],
  RESERVED: ["DESTINATION_AUTHORIZED", "TIMED_OUT"],
  DESTINATION_AUTHORIZED: ["SETTLED", "DESTINATION_FAILED"],
  SETTLED: ["COMPLETE"],
  COMPLETE: [],
  TIMED_OUT: ["RECOVERY_REQUIRED"],
  DESTINATION_FAILED: ["RECOVERY_REQUIRED"],
  RECOVERY_REQUIRED: ["RECOVERED"],
  RECOVERED: [],
};

export interface CrossChainIntent {
  intentId: `0x${string}`;
  source: { chain: string; account: string; asset: string; amount: bigint };
  destination: { chain: string; account: string; asset: string; action: string; adapterId: string; beneficiary: string; minAmount: bigint };
  deadline: number;
  transport: string;
  /**
   * Signed authority for an on-chain destination (e.g. the source ActionIntent, its agent
   * signature and the DestSpec it commits to). Opaque to the runtime; only the destination
   * endpoint interprets it, and the chain re-verifies it.
   */
  authority?: unknown;
}

/** What the transport says arrived; everything in it is untrusted until the destination checks it. */
export interface Delivery {
  messageId: string;
  intentId: `0x${string}`;
  sourceChain: string;
  sourceAccount: string;
  destinationChain: string;
  destinationAccount: string;
  asset: string;
  amount: bigint;
  deliveredAt: number;
  proof: string;
}

export interface Transport {
  readonly id: string;
  send(intent: CrossChainIntent): Promise<{ messageId: string; sourceTx: string }>;
  poll(messageId: string): Promise<{ status: "PENDING" } | { status: "DELIVERED"; delivery: Delivery } | { status: "FAILED"; reason: string }>;
}

export function intentId(i: Omit<CrossChainIntent, "intentId">, nonce: bigint): `0x${string}` {
  return keccak256(toHex(JSON.stringify([i.source.chain, i.source.account, i.source.asset, i.source.amount.toString(), i.destination.chain, i.destination.account, i.destination.asset, i.destination.action, i.destination.adapterId, i.destination.beneficiary, i.destination.minAmount.toString(), i.deadline, i.transport, nonce.toString()])));
}

export type ReservationRejection =
  | "UNKNOWN_INTENT"
  | "DUPLICATE_DELIVERY"
  | "WRONG_SOURCE"
  | "WRONG_DESTINATION"
  | "WRONG_ASSET"
  | "AMOUNT_BELOW_MINIMUM"
  | "AMOUNT_ABOVE_INTENT"
  | "DEADLINE_PASSED";

export interface Reservation {
  intentId: `0x${string}`;
  asset: string;
  amount: bigint;
  action: string;
  adapterId: string;
  beneficiary: string;
  consumed: boolean;
}

export type ReserveResult = { ok: true; reservation: Reservation; tx?: string } | { ok: false; code: ReservationRejection | string };

/**
 * Where arrived funds are checked and reserved. `ON_CHAIN` endpoints are the destination Amane
 * account itself (the transport proof is redeemed there and the chain enforces every pinned
 * field); `LOCAL_MIRROR` is the in-process model of those rules for tests and simulation.
 */
export interface DestinationEndpoint {
  readonly chain: string;
  readonly account: string;
  readonly enforcement: "ON_CHAIN" | "LOCAL_MIRROR";
  expect(i: CrossChainIntent): void;
  reserve(d: Delivery): ReserveResult | Promise<ReserveResult>;
}

/**
 * Destination-side guard (the checks the destination Amane endpoint enforces). Arrived funds are
 * reserved for exactly one intent; a reservation can be consumed once, only by its pinned action,
 * adapter and beneficiary, and never by another lease or intent.
 */
export class DestinationGuard implements DestinationEndpoint {
  readonly enforcement = "LOCAL_MIRROR" as const;
  private readonly known = new Map<string, CrossChainIntent>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly seenMessages = new Set<string>();
  constructor(readonly chain: string, readonly account: string, private readonly clock: () => number = Date.now) {}

  /** The destination learns intents from the owner-signed policy/plan, never from the transport. */
  expect(i: CrossChainIntent) {
    if (i.destination.chain !== this.chain || i.destination.account.toLowerCase() !== this.account.toLowerCase()) throw new Error("intent is not for this endpoint");
    this.known.set(i.intentId, i);
  }

  reserve(d: Delivery): { ok: true; reservation: Reservation } | { ok: false; code: ReservationRejection } {
    const i = this.known.get(d.intentId);
    if (!i) return { ok: false, code: "UNKNOWN_INTENT" };
    if (this.seenMessages.has(d.messageId) || this.reservations.has(d.intentId)) return { ok: false, code: "DUPLICATE_DELIVERY" };
    if (d.sourceChain !== i.source.chain || d.sourceAccount.toLowerCase() !== i.source.account.toLowerCase()) return { ok: false, code: "WRONG_SOURCE" };
    if (d.destinationChain !== this.chain || d.destinationAccount.toLowerCase() !== this.account.toLowerCase()) return { ok: false, code: "WRONG_DESTINATION" };
    if (d.asset !== i.destination.asset) return { ok: false, code: "WRONG_ASSET" };
    if (d.amount < i.destination.minAmount) return { ok: false, code: "AMOUNT_BELOW_MINIMUM" };
    if (d.amount > i.source.amount && i.source.asset === i.destination.asset) return { ok: false, code: "AMOUNT_ABOVE_INTENT" };
    if (this.clock() > i.deadline) return { ok: false, code: "DEADLINE_PASSED" };
    this.seenMessages.add(d.messageId);
    const r: Reservation = { intentId: i.intentId, asset: d.asset, amount: d.amount, action: i.destination.action, adapterId: i.destination.adapterId, beneficiary: i.destination.beneficiary, consumed: false };
    this.reservations.set(i.intentId, r);
    return { ok: true, reservation: r };
  }

  /** Only the intent's pinned destination action can spend its reservation, once. */
  consume(req: { intentId: `0x${string}`; action: string; adapterId: string; beneficiary: string; amount: bigint }): { ok: true } | { ok: false; code: "NO_RESERVATION" | "ALREADY_CONSUMED" | "WRONG_ACTION" | "WRONG_ADAPTER" | "WRONG_BENEFICIARY" | "OVER_RESERVATION" } {
    const r = this.reservations.get(req.intentId);
    if (!r) return { ok: false, code: "NO_RESERVATION" };
    if (r.consumed) return { ok: false, code: "ALREADY_CONSUMED" };
    if (req.action !== r.action) return { ok: false, code: "WRONG_ACTION" };
    if (req.adapterId !== r.adapterId) return { ok: false, code: "WRONG_ADAPTER" };
    if (req.beneficiary.toLowerCase() !== r.beneficiary.toLowerCase()) return { ok: false, code: "WRONG_BENEFICIARY" };
    if (req.amount > r.amount) return { ok: false, code: "OVER_RESERVATION" };
    r.consumed = true;
    return { ok: true };
  }

  /** Unreserved funds for everyone else: a reservation is invisible to other leases and intents. */
  reserved(asset: string): bigint {
    return [...this.reservations.values()].filter((r) => r.asset === asset && !r.consumed).reduce((s, r) => s + r.amount, 0n);
  }

  /** After the deadline an unconsumed reservation is released to owner recovery only. */
  releaseExpired(intentId: `0x${string}`): Reservation | null {
    const i = this.known.get(intentId);
    const r = this.reservations.get(intentId);
    if (!i || !r || r.consumed || this.clock() <= i.deadline) return null;
    r.consumed = true;
    return r;
  }
}

export interface CrossChainRun {
  intent: CrossChainIntent;
  state: CrossChainState;
  history: { state: CrossChainState; at: number; detail?: string }[];
  messageId?: string;
  sourceTx?: string;
  reservation?: Reservation;
  rejection?: string;
}

export interface CrossChainHooks {
  /** Source endpoint authorizes and commits the outbound transfer (Amane source-side checks). */
  authorizeSource(i: CrossChainIntent): Promise<{ ok: boolean; detail: string }>;
  /** Destination action spending the reservation (Amane destination-side checks + adapter). */
  executeDestination(i: CrossChainIntent, r: Reservation): Promise<{ ok: boolean; detail: string }>;
  /** Owner-only recovery of funds stuck in flight or reserved past the deadline. */
  recover(i: CrossChainIntent, why: string): Promise<{ ok: boolean; detail: string }>;
}

/** Drives one intent through the state machine. Every transition is checked against NEXT and logged. */
export class CrossChainEngine {
  constructor(private readonly transport: Transport, private readonly guard: DestinationEndpoint, private readonly hooks: CrossChainHooks, private readonly log: EventLog, private readonly agentId: string, private readonly clock: () => number = Date.now) {}

  private move(run: CrossChainRun, to: CrossChainState, detail?: string) {
    if (!NEXT[run.state].includes(to)) throw new Error(`illegal cross-chain transition ${run.state} → ${to}`);
    run.state = to;
    run.history.push({ state: to, at: this.clock(), ...(detail ? { detail } : {}) });
    this.log.append({ agentId: this.agentId, type: to === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : to === "RECOVERED" ? "RECOVERY_COMPLETED" : "PLAN_COMPILED", severity: ["TIMED_OUT", "DESTINATION_FAILED", "RECOVERY_REQUIRED"].includes(to) ? "WARNING" : "INFO", data: { crossChain: run.intent.intentId, state: to, ...(detail ? { detail } : {}) } });
  }

  async run(intent: CrossChainIntent, o: { pollIntervalMs: number; maxPolls: number }): Promise<CrossChainRun> {
    const run: CrossChainRun = { intent, state: "CREATED", history: [{ state: "CREATED", at: this.clock() }] };
    this.guard.expect(intent);
    const src = await this.hooks.authorizeSource(intent);
    if (!src.ok) {
      run.rejection = src.detail;
      return run;
    }
    this.move(run, "SOURCE_AUTHORIZED", src.detail);
    let sent: { messageId: string; sourceTx: string };
    try {
      sent = await this.transport.send(intent);
    } catch (err) {
      // The source leg did not commit (e.g. the source Amane endpoint refused it): nothing moved.
      run.rejection = (err as Error).message;
      return run;
    }
    run.messageId = sent.messageId;
    run.sourceTx = sent.sourceTx;
    this.move(run, "SOURCE_COMMITTED", sent.sourceTx);
    this.move(run, "IN_FLIGHT", sent.messageId);
    let delivery: Delivery | null = null;
    for (let n = 0; n < o.maxPolls && this.clock() <= intent.deadline; n++) {
      const p = await this.transport.poll(sent.messageId);
      if (p.status === "DELIVERED") {
        delivery = p.delivery;
        break;
      }
      if (p.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, o.pollIntervalMs));
    }
    if (!delivery) return this.recover(run, "TIMED_OUT", "no delivery before the deadline");
    this.move(run, "ARRIVED", delivery.messageId);
    const res = await this.guard.reserve(delivery);
    if (!res.ok) {
      run.rejection = res.code;
      return this.recover(run, "DESTINATION_FAILED", `destination refused the delivery: ${res.code}`);
    }
    run.reservation = res.reservation;
    this.move(run, "RESERVED", `${res.reservation.amount} ${res.reservation.asset} reserved for ${intent.destination.action} (${this.guard.enforcement === "ON_CHAIN" ? `enforced on-chain${res.tx ? ` ${res.tx}` : ""}` : "local mirror"})`);
    this.move(run, "DESTINATION_AUTHORIZED");
    const dst = await this.hooks.executeDestination(intent, res.reservation);
    if (!dst.ok) return this.recover(run, "DESTINATION_FAILED", dst.detail);
    this.move(run, "SETTLED", dst.detail);
    this.move(run, "COMPLETE");
    return run;
  }

  private async recover(run: CrossChainRun, failure: "TIMED_OUT" | "DESTINATION_FAILED", detail: string): Promise<CrossChainRun> {
    if (NEXT[run.state].includes(failure)) this.move(run, failure, detail);
    else run.history.push({ state: failure, at: this.clock(), detail });
    run.state = failure;
    this.move(run, "RECOVERY_REQUIRED", detail);
    const r = await this.hooks.recover(run.intent, detail);
    if (r.ok) this.move(run, "RECOVERED", r.detail);
    return run;
  }
}

/** Deterministic transport for tests and simulation: it can delay, lose, duplicate or tamper. */
export class MockTransport implements Transport {
  readonly id = "mock-transport";
  private readonly sent = new Map<string, { intent: CrossChainIntent; polls: number }>();
  constructor(private readonly behaviour: { delayPolls?: number; lose?: boolean; tamper?: (d: Delivery) => Delivery; fail?: string } = {}, private readonly clock: () => number = Date.now) {}
  async send(intent: CrossChainIntent) {
    const messageId = keccak256(toHex(`mock:${intent.intentId}`));
    this.sent.set(messageId, { intent, polls: 0 });
    return { messageId, sourceTx: `mock-source-${intent.intentId.slice(2, 10)}` };
  }
  async poll(messageId: string) {
    const s = this.sent.get(messageId);
    if (!s) return { status: "FAILED" as const, reason: "unknown message" };
    if (this.behaviour.fail) return { status: "FAILED" as const, reason: this.behaviour.fail };
    if (this.behaviour.lose || ++s.polls <= (this.behaviour.delayPolls ?? 0)) return { status: "PENDING" as const };
    const i = s.intent;
    const d: Delivery = { messageId, intentId: i.intentId, sourceChain: i.source.chain, sourceAccount: i.source.account, destinationChain: i.destination.chain, destinationAccount: i.destination.account, asset: i.destination.asset, amount: i.source.asset === i.destination.asset ? i.source.amount : i.destination.minAmount, deliveredAt: this.clock(), proof: "mock" };
    return { status: "DELIVERED" as const, delivery: this.behaviour.tamper ? this.behaviour.tamper(d) : d };
  }
}
