import type { AgentIdentityProvider, IdentityResolution } from "./core.js";
import { KidoPublicAgentManifestSchema, type KidoPublicAgentManifest } from "./core.js";

export type BindingVerdict = "VERIFIED" | "NOT_FOUND" | "PLANNED_NOT_REGISTERED" | "REVOKED" | "WRONG_AGENT" | "STALE" | "WRONG_ADDRESS" | "INVALID_NAME" | "UNVERIFIABLE";

export interface BindingCheck {
  providerId: string;
  name: string;
  verdict: BindingVerdict;
  detail: string;
  manifest: KidoPublicAgentManifest | null;
  resolution: IdentityResolution | null;
}

const NAME_RULES: Record<string, RegExp> = {
  ens: /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/,
  suins: /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+sui$/,
};

/**
 * Checks one chain-native name against what the agent is: same KidoAgentId, current blueprint
 * commitment, expected account address. A name is discovery only; a failed check never affects
 * financial authority, it only means the name must not be trusted as this agent.
 */
export async function verifyBinding(provider: AgentIdentityProvider, name: string, expect: { kidoAgentId: string; blueprintCommitment?: string; account?: string; planned?: boolean }): Promise<BindingCheck> {
  const base = { providerId: provider.providerId, name, manifest: null, resolution: null };
  const rule = NAME_RULES[provider.providerId];
  if (rule && !rule.test(name)) return { ...base, verdict: "INVALID_NAME", detail: `not a valid ${provider.providerId} name` };
  // Registration first: some name services resolve an unregistered subname through its parent.
  const status = await provider.inspect(name);
  const r = await provider.resolve(name);
  if (!status.registered || !r.found) return { ...base, resolution: r, verdict: expect.planned ? "PLANNED_NOT_REGISTERED" : "NOT_FOUND", detail: expect.planned ? "binding planned; name not registered" : "name does not resolve" };
  let manifest: KidoPublicAgentManifest | null = null;
  const raw = r.records["agent-context"];
  if (raw) {
    try {
      manifest = KidoPublicAgentManifestSchema.parse(JSON.parse(raw));
    } catch {
      return { ...base, resolution: r, verdict: "UNVERIFIABLE", detail: "agent-context record is not a valid Kido manifest" };
    }
  }
  const agentId = r.kidoAgentId ?? manifest?.kidoAgentId ?? null;
  if (!agentId) return { ...base, resolution: r, manifest, verdict: "REVOKED", detail: "name resolves but carries no KidoAgentId (records cleared)" };
  if (agentId !== expect.kidoAgentId || (manifest && manifest.kidoAgentId !== agentId)) return { ...base, resolution: r, manifest, verdict: "WRONG_AGENT", detail: `bound to ${agentId}` };
  if (expect.blueprintCommitment && manifest?.blueprintCommitment && manifest.blueprintCommitment !== expect.blueprintCommitment) return { ...base, resolution: r, manifest, verdict: "STALE", detail: `advertises blueprint ${manifest.blueprintCommitment.slice(0, 10)}…, current is ${expect.blueprintCommitment.slice(0, 10)}…` };
  if (expect.account) {
    const advertised = Object.values(manifest?.accounts ?? {}).map((a) => a.toLowerCase());
    const addr = r.address?.toLowerCase();
    if (!advertised.includes(expect.account.toLowerCase()) && addr !== expect.account.toLowerCase()) return { ...base, resolution: r, manifest, verdict: "WRONG_ADDRESS", detail: "advertised account differs from the agent's account" };
  }
  return { ...base, resolution: r, manifest, verdict: "VERIFIED", detail: "same KidoAgentId, current commitment" };
}
