import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuinsClient } from "@mysten/suins";
import type { AgentIdentityProvider, IdentityCapability, IdentityReceipt, IdentityResolution, IdentityStatus } from "./core.js";

/**
 * SuiNS identity adapter (Sui testnet). SuiNS differs from ENS and the adapter says so: records are
 * limited to avatar, content_hash and walrus_site_id, so the KidoAgentId ↔ name mapping cannot be
 * published as a free-form text record; resolution gives the target address and the default
 * (reverse) name, which only the target itself can set. Registration needs test USDC/NS or a Pyth
 * access token (BC-SUINS-1), so REGISTER/SUBNAME report BLOCKED_ENV instead of pretending.
 */
export class SuiNsIdentityAdapter implements AgentIdentityProvider {
  readonly providerId = "suins";
  readonly chain = "sui-testnet" as const;
  private readonly suins: SuinsClient;

  constructor(readonly client: SuiGrpcClient) {
    this.suins = new SuinsClient({ client: client as never, network: "testnet" });
  }

  capabilities(): IdentityCapability[] {
    return ["RESOLVE", "REVERSE_RESOLVE", "ADDRESS_RECORD", "EXPIRY"];
  }

  async resolve(name: string): Promise<IdentityResolution> {
    const records: Record<string, string> = {};
    let address: string | null = null;
    let found = false;
    try {
      const r = await this.client.resolveNameServiceAddress({ name });
      address = r.address ?? null;
      found = address !== null;
    } catch {
      /* not registered */
    }
    try {
      const rec = await this.suins.getNameRecord(name);
      if (rec) {
        found = true;
        for (const [k, v] of Object.entries(rec.data ?? {})) records[k] = String(v);
      }
    } catch {
      /* the SDK throws for unknown names instead of returning null */
    }
    return { providerId: this.providerId, name, found, address, records, kidoAgentId: null, resolvedAt: Date.now() };
  }

  async reverseResolve(address: string): Promise<IdentityResolution> {
    try {
      const r = await this.client.defaultNameServiceName({ address });
      const name = r.data?.name ?? null;
      return { providerId: this.providerId, name: name ?? "", found: name !== null, address, records: {}, kidoAgentId: null, resolvedAt: Date.now() };
    } catch {
      return { providerId: this.providerId, name: "", found: false, address, records: {}, kidoAgentId: null, resolvedAt: Date.now() };
    }
  }

  async inspect(name: string): Promise<IdentityStatus> {
    let expiresAt: number | null = null;
    let records: Record<string, string> = {};
    let registered = false;
    try {
      const rec = await this.suins.getNameRecord(name);
      if (rec) {
        registered = true;
        expiresAt = Number(rec.expirationTimestampMs);
        records = Object.fromEntries(Object.entries(rec.data ?? {}).map(([k, v]) => [k, String(v)]));
      }
    } catch {
      /* unknown name */
    }
    return { providerId: this.providerId, name, registered, records, expiresAt, revoked: false };
  }

  async register(label: string): Promise<IdentityReceipt> {
    return { providerId: this.providerId, chain: this.chain, operation: "REGISTER", name: `${label}.sui`, txs: [], status: "BLOCKED_ENV", detail: "BC-SUINS-1: registration needs test USDC/NS or a Pyth access token" };
  }
}
