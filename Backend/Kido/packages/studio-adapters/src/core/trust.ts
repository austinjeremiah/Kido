import { z } from "zod";

/**
 * The trust model.
 *
 * A number is not a number. `3021.44` from a Chainlink feed and `3021.44` from a subgraph are
 * numerically identical and are not interchangeable, because they answer different questions: one
 * is a value a decentralised oracle network attested to, the other is a value an indexer observed
 * and may still be catching up on.
 *
 * Trust is therefore a property of the ADAPTER, declared in its manifest and enforced by code. It
 * is never inferred from a provider's name, never guessed from the shape of a response, and never
 * chosen by a language model. "It came from Chainlink so it must be verified" is exactly the
 * reasoning this type exists to make impossible — a Chainlink *Functions* result is not a
 * verified-oracle reading, and the manifest says so.
 */
export const DataTrustClass = {
  /** Computed inside an attested confidential environment over secrets the caller never sees. */
  CONFIDENTIAL_VERIFIED_COMPUTE: "CONFIDENTIAL_VERIFIED_COMPUTE",
  /** A decentralised oracle network's attested value. */
  VERIFIED_ORACLE: "VERIFIED_ORACLE",
  /** Chain data reconstructed by an indexer. True, but possibly behind the head. */
  INDEXED_CHAIN_DATA: "INDEXED_CHAIN_DATA",
  /** Read directly from a node. Current, but trusts one RPC provider. */
  DIRECT_CHAIN_DATA: "DIRECT_CHAIN_DATA",
  /** An HTTP endpoint. Whatever it says, it says. */
  EXTERNAL_API: "EXTERNAL_API",
  /** Supplied by the agent or the user. Assumed hostile. */
  USER_UNTRUSTED: "USER_UNTRUSTED",
} as const;
export type DataTrustClass = (typeof DataTrustClass)[keyof typeof DataTrustClass];

export const DataTrustClassSchema = z.enum([
  "CONFIDENTIAL_VERIFIED_COMPUTE",
  "VERIFIED_ORACLE",
  "INDEXED_CHAIN_DATA",
  "DIRECT_CHAIN_DATA",
  "EXTERNAL_API",
  "USER_UNTRUSTED",
]);

/**
 * Strength ordering, highest first.
 *
 * Deliberately a total order, and deliberately NOT a judgement about which source is "better". It
 * answers exactly one question: does this adapter meet or exceed the trust the Blueprint demanded?
 * A requirement for INDEXED_CHAIN_DATA is happily satisfied by a VERIFIED_ORACLE; the reverse is
 * the substitution that loses money.
 */
const RANK: Record<DataTrustClass, number> = {
  CONFIDENTIAL_VERIFIED_COMPUTE: 5,
  VERIFIED_ORACLE: 4,
  INDEXED_CHAIN_DATA: 3,
  DIRECT_CHAIN_DATA: 2,
  EXTERNAL_API: 1,
  USER_UNTRUSTED: 0,
};

export function trustRank(c: DataTrustClass): number {
  return RANK[c];
}

/** `offered` may stand in for `required` only when it is at least as strong. */
export function satisfiesTrust(offered: DataTrustClass, required: DataTrustClass): boolean {
  return RANK[offered] >= RANK[required];
}

export function isTrustDowngrade(from: DataTrustClass, to: DataTrustClass): boolean {
  return RANK[to] < RANK[from];
}

/**
 * Why DIRECT_CHAIN_DATA sits *below* INDEXED_CHAIN_DATA.
 *
 * It looks backwards — a direct node read is fresher than an indexer. But freshness is a separate
 * axis, carried by `maxAgeMs`, and this ordering is about how much independent corroboration stands
 * behind a value. A single RPC endpoint is one party that can lie or be wrong; a public subgraph is
 * a deterministic reduction of chain history that many parties can reproduce and disagree about
 * loudly. A policy that wants "fresh" should say `maxAgeMs`, not reach for a stronger trust class.
 */
export const TRUST_ORDERING_RATIONALE =
  "Trust ranks corroboration, not recency. Freshness is enforced separately by maxAgeMs.";
