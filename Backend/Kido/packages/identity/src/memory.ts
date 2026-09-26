import type { ChainId } from "@kido/blueprint";
import type { AgentIdentityProvider, IdentityCapability, IdentityReceipt, IdentityResolution, IdentityStatus, PublicRecords } from "./core.js";

/**
 * In-memory identity provider for local conformance tests (IMPLEMENTED_LOCAL). It implements the
 * same interface as the live adapters so binding, rotation and revocation logic can be exercised for
 * providers whose live registration is blocked. It is never a substitute for a live claim.
 */
export class MemoryIdentityProvider implements AgentIdentityProvider {
  private readonly names = new Map<string, { records: PublicRecords; address: string | null }>();
  constructor(readonly providerId: string, readonly chain: ChainId) {}
  capabilities(): IdentityCapability[] {
    return ["RESOLVE", "REGISTER", "SUBNAME", "TEXT_RECORDS", "REVOKE"];
  }
  private receipt(operation: IdentityReceipt["operation"], name: string): IdentityReceipt {
    return { providerId: this.providerId, chain: this.chain, operation, name, txs: [], status: "CONFIRMED", detail: "local conformance provider" };
  }
  async register(label: string, owner: string) {
    const name = `${label}.${this.providerId === "ens" ? "eth" : "sui"}`;
    this.names.set(name, { records: {}, address: owner });
    return this.receipt("REGISTER", name);
  }
  async createSubIdentity(parent: string, label: string, records: PublicRecords) {
    this.names.set(`${label}.${parent}`, { records: { ...records }, address: null });
    return this.receipt("SUBNAME", `${label}.${parent}`);
  }
  async publishRecords(name: string, records: PublicRecords) {
    const n = this.names.get(name);
    if (!n) return { ...this.receipt("PUBLISH_RECORDS", name), status: "FAILED" as const, detail: "unknown name" };
    for (const [k, v] of Object.entries(records)) v ? (n.records[k] = v) : delete n.records[k];
    return this.receipt("PUBLISH_RECORDS", name);
  }
  async revoke(name: string, mode: "CLEAR_RECORDS" | "UNBIND" | "BURN_SUBNAME") {
    if (mode === "BURN_SUBNAME") this.names.delete(name);
    else this.names.get(name) && (this.names.get(name)!.records = {});
    return this.receipt("REVOKE", name);
  }
  async resolve(name: string): Promise<IdentityResolution> {
    const n = this.names.get(name);
    return { providerId: this.providerId, name, found: Boolean(n), address: n?.address ?? null, records: n ? { ...n.records } : {}, kidoAgentId: n?.records["kido-agent-id"] ?? null, resolvedAt: Date.now() };
  }
  async inspect(name: string): Promise<IdentityStatus> {
    const n = this.names.get(name);
    return { providerId: this.providerId, name, registered: Boolean(n), records: n ? { ...n.records } : {}, expiresAt: null, revoked: Boolean(n) && Object.keys(n!.records).length === 0 };
  }
}
