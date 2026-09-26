/** Bible §22.1: every observation carries provenance, freshness and an explicit trust class. */
export type TrustClass = "USER_UNTRUSTED" | "RPC_DIRECT" | "INDEXED" | "VERIFIED_ORACLE" | "VERIFIED_COMPUTE";

export interface DataObservation<T> {
  id: string;
  adapterId: string;
  chain: string;
  subject: string;
  kind: string;
  value: T;
  unit?: string;
  decimals?: number;
  observedAt: number;
  blockRef?: string;
  freshnessMs: number;
  trust: TrustClass;
}

const TRUST_ORDER: TrustClass[] = ["USER_UNTRUSTED", "RPC_DIRECT", "INDEXED", "VERIFIED_ORACLE", "VERIFIED_COMPUTE"];

/** No silent trust downgrade: an observation below the required class is unusable, not "close enough". */
export function meetsTrust(o: DataObservation<unknown>, required: TrustClass): boolean {
  return TRUST_ORDER.indexOf(o.trust) >= TRUST_ORDER.indexOf(required);
}

export function isFresh(o: DataObservation<unknown>, now: number): boolean {
  return now - o.observedAt <= o.freshnessMs;
}
