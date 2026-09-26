import { z } from "zod";
import type { ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import type { ProviderRegistry } from "@kido/registry";

export type IdentityCapability = "RESOLVE" | "REVERSE_RESOLVE" | "REGISTER" | "SUBNAME" | "TEXT_RECORDS" | "ADDRESS_RECORD" | "SCOPED_RECORD_MANAGER" | "REVOKE" | "EXPIRY";

export interface IdentityResolution {
  providerId: string;
  name: string;
  found: boolean;
  address: string | null;
  records: Record<string, string>;
  kidoAgentId: string | null;
  resolvedAt: number;
}

export interface IdentityReceipt {
  providerId: string;
  chain: ChainId;
  operation: "REGISTER" | "SUBNAME" | "PUBLISH_RECORDS" | "REVOKE";
  name: string;
  txs: string[];
  status: "CONFIRMED" | "FAILED" | "BLOCKED_ENV";
  detail?: string | undefined;
}

export interface IdentityStatus {
  providerId: string;
  name: string;
  registered: boolean;
  records: Record<string, string>;
  expiresAt: number | null;
  revoked: boolean;
}

export type PublicRecords = Record<string, string>;

/**
 * Common identity provider interface (bible §24.2). Adapters expose only the capabilities they
 * actually support; nothing here can grant or imply financial authority.
 */
export interface AgentIdentityProvider {
  readonly providerId: string;
  readonly chain: ChainId;
  capabilities(): IdentityCapability[];
  resolve(name: string, keys?: string[]): Promise<IdentityResolution>;
  reverseResolve?(address: string): Promise<IdentityResolution>;
  register?(label: string, owner: string): Promise<IdentityReceipt>;
  createSubIdentity?(parent: string, label: string, records: PublicRecords): Promise<IdentityReceipt>;
  publishRecords?(name: string, records: PublicRecords): Promise<IdentityReceipt>;
  revoke?(name: string, mode: "CLEAR_RECORDS" | "UNBIND" | "BURN_SUBNAME"): Promise<IdentityReceipt>;
  inspect(name: string): Promise<IdentityStatus>;
}

export const KidoPublicAgentManifestSchema = z
  .object({
    kidoAgentId: z.string().regex(/^kido:agent:[a-z2-7]{16}$/),
    agentVersion: z.string(),
    description: z.string().max(280).optional(),
    supportedChains: z.array(z.string()),
    publicCapabilities: z.array(z.string()),
    webEndpoint: z.string().url().optional(),
    apiEndpoint: z.string().url().optional(),
    mcpEndpoint: z.string().url().optional(),
    sourceRepository: z.string().url().optional(),
    blueprintCommitment: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
    amaneAccountId: z.string().optional(),
    /** Every chain-native name bound to this KidoAgentId; none of them is the root identity. */
    bindings: z.array(z.object({ provider: z.string(), chain: z.string(), name: z.string() }).strict()).optional(),
    /** Public addresses of the agent's account endpoints, per chain. */
    accounts: z.record(z.string(), z.string()).optional(),
    authorityNote: z.literal("Advertised capabilities are not financial authority; authority is enforced on-chain by the account's own policy."),
  })
  .strict();
export type KidoPublicAgentManifest = z.infer<typeof KidoPublicAgentManifestSchema>;

export class UnsafePublicRecordError extends Error {
  constructor(readonly reason: string) {
    super(`KIDO_ENS_UNSAFE_RECORD: ${reason}`);
    this.name = "UnsafePublicRecordError";
  }
}

const SECRETISH = /(sk-[A-Za-z0-9]{12,}|-----BEGIN|suiprivkey1|private[_ -]?key|mnemonic|api[_ -]?key\s*[:=])/i;

/**
 * Public records never contain secrets, private thresholds, private strategy parameters or
 * spending limits (bible §24.3). The check is structural (strict schema) and content-based.
 */
export function assertPublicSafe(records: PublicRecords, bp: KidoAgentBlueprint): void {
  const text = Object.values(records).join("\n");
  if (SECRETISH.test(text)) throw new UnsafePublicRecordError("secret-shaped content");
  for (const m of bp.monitors) {
    if (m.thresholdPrivateRef && m.threshold && text.includes(m.threshold)) throw new UnsafePublicRecordError(`private threshold ${m.thresholdPrivateRef}`);
  }
  for (const l of bp.authority.limits) {
    for (const v of [l.perAction, l.perWindow, l.total]) if (v.length > 3 && text.includes(v)) throw new UnsafePublicRecordError("spending limit value");
  }
  for (const v of bp.privacy.values) if (text.toLowerCase().includes(`"${v.id}":`)) throw new UnsafePublicRecordError(`private value ${v.id}`);
}

export function buildPublicManifest(bp: KidoAgentBlueprint, blueprintHash: string, opts: { amaneAccountId?: string; endpoints?: { web?: string; api?: string; mcp?: string }; bindings?: { provider: string; chain: string; name: string }[]; accounts?: Record<string, string> } = {}): KidoPublicAgentManifest {
  const m: KidoPublicAgentManifest = {
    kidoAgentId: bp.kidoAgentId,
    agentVersion: String(bp.revision),
    description: bp.objective.summary ?? undefined,
    supportedChains: bp.chains,
    publicCapabilities: bp.identity.advertisedCapabilities,
    ...(opts.endpoints?.web ? { webEndpoint: opts.endpoints.web } : {}),
    ...(opts.endpoints?.api ? { apiEndpoint: opts.endpoints.api } : {}),
    ...(opts.endpoints?.mcp ? { mcpEndpoint: opts.endpoints.mcp } : {}),
    blueprintCommitment: blueprintHash,
    ...(opts.amaneAccountId ? { amaneAccountId: opts.amaneAccountId } : {}),
    ...(opts.bindings?.length ? { bindings: opts.bindings } : {}),
    ...(opts.accounts && Object.keys(opts.accounts).length ? { accounts: opts.accounts } : {}),
    authorityNote: "Advertised capabilities are not financial authority; authority is enforced on-chain by the account's own policy.",
  };
  if (m.description === undefined) delete m.description;
  return KidoPublicAgentManifestSchema.parse(m);
}

export interface PlannedBinding {
  providerId: string;
  chain: ChainId;
  name: string;
  parent: string;
  label: string;
  records: PublicRecords;
  liveCapable: boolean;
  blockers: string[];
  /** Set on a specialist's own subname under the agent's name (e.g. `swap.treasury.acme.eth`). */
  role?: string;
}

function slug(s: string, max: number): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "kido";
}

/**
 * Identity compiler (bible §24): one binding per chain whose provider supports resolution, named
 * `<role>.<org>.<tld>`. Live capability is reported per binding from per-capability status.
 */
export function compileIdentityPlan(bp: KidoAgentBlueprint, reg: ProviderRegistry, manifest: KidoPublicAgentManifest): PlannedBinding[] {
  if (bp.identity.public !== true) return [];
  const org = slug(bp.identity.organization ?? bp.projectId, 40);
  const role = slug(bp.agents[0]?.role.replace(/Agent$/, "") ?? "agent", 20);
  const out: PlannedBinding[] = [];
  for (const chain of bp.chains) {
    const sel = reg.select({ kind: "identity", chain, capabilities: ["RESOLVE"], acceptStatus: ["VERIFIED_LIVE", "VERIFIED_DOCS", "UNVERIFIED"] });
    const p = sel.selected[0];
    if (!p) continue;
    const tld = p.providerId === "ens" ? "eth" : "sui";
    // A name the owner chose in the interview wins over the derived `<role>.<org>` name.
    const chosen = bp.identity.bindings.find((b) => b.provider === p.providerId && b.chain === chain)?.name;
    const [chosenLabel, ...chosenParent] = chosen ? chosen.split(".") : [];
    const parent = chosen && chosenParent.length >= 2 ? chosenParent.join(".") : `${org.length < 5 ? `${org}-kido` : org}.${tld}`;
    const records: PublicRecords =
      p.providerId === "ens"
        ? { "agent-context": JSON.stringify(manifest), "kido-agent-id": manifest.kidoAgentId, ...(manifest.webEndpoint ? { "agent-endpoint[web]": manifest.webEndpoint } : {}), ...(manifest.mcpEndpoint ? { "agent-endpoint[mcp]": manifest.mcpEndpoint } : {}) }
        : {};
    const needed = ["REGISTER", "SUBNAME", ...(Object.keys(records).length ? ["TEXT_RECORDS"] : [])];
    const blockers = needed.flatMap((c) => {
      const st = p.capabilityStatus?.[c]?.status ?? p.status;
      return st === "VERIFIED_LIVE" ? [] : [`${p.providerId} ${c}: ${p.capabilityStatus?.[c]?.note ?? p.statusNote}`];
    });
    const label = chosen && chosenParent.length >= 2 ? slug(chosenLabel!, 20) : role;
    const agentName = `${label}.${parent}`;
    out.push({ providerId: p.providerId, chain, name: agentName, parent, label, records, liveCapable: blockers.length === 0, blockers });
    // Every specialist is discoverable under the agent's name. Names are discovery only: a
    // specialist's subname carries its role, never authority.
    const subBlockers = ["SUBNAME", ...(p.providerId === "ens" ? ["TEXT_RECORDS"] : [])].flatMap((c) => {
      const st = p.capabilityStatus?.[c]?.status ?? p.status;
      return st === "VERIFIED_LIVE" ? [] : [`${p.providerId} ${c}: ${p.capabilityStatus?.[c]?.note ?? p.statusNote}`];
    });
    for (const a of bp.agents) {
      const sub = slug(a.role.replace(/Agent$/, ""), 20);
      const subRecords: PublicRecords = p.providerId === "ens" ? { "kido-agent-id": manifest.kidoAgentId, "kido-agent-role": a.role } : {};
      out.push({ providerId: p.providerId, chain, name: `${sub}.${agentName}`, parent: agentName, label: sub, records: subRecords, liveCapable: blockers.length === 0 && subBlockers.length === 0, blockers: [...new Set([...blockers, ...subBlockers])], role: a.role });
    }
  }
  return out;
}
