import type { Address, Hex, PublicClient } from "viem";
import { AmaneEvmEndpoint, AmaneSuiEndpoint } from "@kido/amane-bridge";
import { blueprintHash } from "@kido/blueprint";
import { CHAINS } from "@kido/registry";
import type { Foundry } from "./service.js";

type SuiClient = ConstructorParameters<typeof AmaneSuiEndpoint>[0];
type SuiSigner = ConstructorParameters<typeof AmaneSuiEndpoint>[3];

/** What the name resolves to, as an ENS reader returns it. */
export interface NameReading {
  name: string;
  registered: boolean;
  records: Record<string, string>;
  /** Address per chain the records name ("ethereum-sepolia", "sui-testnet"), from the multichain coin types. */
  addresses: Record<string, string | null>;
}

export interface VerifyCheck {
  id: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

/**
 * Verifies an agent from its ENS name alone: the name's records commit to a Kido agent id, a
 * blueprint and an Amane account; each account the name resolves to is read on its own chain and
 * must carry that account id, an installed owner policy and no pause. A name is discovery: this
 * checks that what it points at really is the agent it claims, and what that agent may do.
 */
export async function verifyAgentName(
  n: NameReading,
  d: { foundry: Foundry; evm?: { publicClient: PublicClient }; sui?: { client: SuiClient; relayer: SuiSigner }; subnames?: (name: string) => Promise<{ name: string; role: string | null }[]> },
) {
  const checks: VerifyCheck[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => checks.push({ id, label, ok, detail });
  add("registered", "The name exists on ENS", n.registered, n.registered ? `${n.name} is registered` : `${n.name} is not registered`);
  let manifest: { kidoAgentId?: string; amaneAccountId?: string; accounts?: Record<string, string>; blueprintCommitment?: string; authorityNote?: string; supportedChains?: string[]; publicCapabilities?: string[] } | null = null;
  try {
    manifest = n.records["agent-context"] ? JSON.parse(n.records["agent-context"]) : null;
  } catch {
    manifest = null;
  }
  add("manifest", "It publishes a Kido agent manifest", Boolean(manifest), manifest ? `agent-context record: ${manifest.kidoAgentId}` : "no readable agent-context record");
  if (!manifest) return { name: n.name, verified: false, checks, agent: null };
  add("agent-id", "Its agent id records agree", n.records["kido-agent-id"] === manifest.kidoAgentId, `kido-agent-id ${n.records["kido-agent-id"] ?? "missing"}`);
  add("authority-note", "It states that the name grants no authority", /not financial authority/i.test(manifest.authorityNote ?? ""), manifest.authorityNote ?? "no authority note");

  // Public RPCs rate-limit bursts; one retry after a short pause before calling a read failed.
  const retry = async <T,>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      return f();
    }
  };
  const onchain: Record<string, unknown>[] = [];
  for (const [chain, account] of Object.entries(manifest.accounts ?? {})) {
    const resolved = n.addresses[chain];
    add(`addr-${chain}`, `The name resolves to its ${chain} account`, resolved ? resolved.toLowerCase() === account.toLowerCase() : false, resolved ? `ENS → ${resolved}` : "no address record for this chain");
    const family = CHAINS.find((c) => c.chainId === chain)?.family;
    try {
      if (family === "evm" && d.evm) {
        const st = await retry(() => new AmaneEvmEndpoint(d.evm!.publicClient as never, null as never, account as Address).state());
        add(`acct-${chain}`, `The ${chain} account is this agent's Amane account`, st.accountId.toLowerCase() === manifest.amaneAccountId?.toLowerCase(), `on-chain account id ${st.accountId}`);
        add(`policy-${chain}`, `An owner policy is installed on ${chain}`, st.policyVersion > 0n && !st.paused, `policy v${st.policyVersion}${st.paused ? ", paused" : ""}`);
        onchain.push({ chain, account, accountId: st.accountId, policyVersion: Number(st.policyVersion), paused: st.paused });
      } else if (family === "sui" && d.sui) {
        const obj = await retry(() => (d.sui!.client as unknown as { core: { getObject(o: { objectId: string }): Promise<{ object: { type: string } }> } }).core.getObject({ objectId: account }));
        const pkg = obj.object.type.split("::")[0]!;
        const ep = new AmaneSuiEndpoint(d.sui.client, pkg, account, d.sui.relayer);
        const [id, pv, paused] = await retry(() => Promise.all([ep.accountId(), ep.policyVersion(), ep.isPaused()]));
        add(`acct-${chain}`, `The ${chain} account is this agent's Amane account`, id.toLowerCase() === manifest.amaneAccountId?.toLowerCase(), `on-chain account id ${id}`);
        add(`policy-${chain}`, `An owner policy is installed on ${chain}`, pv > 0n && !paused, `policy v${pv}${paused ? ", paused" : ""}`);
        onchain.push({ chain, account, accountId: id, policyVersion: Number(pv), paused, core: pkg });
      } else add(`acct-${chain}`, `The ${chain} account can be read`, null, "no reader for this chain on this backend");
    } catch (e) {
      add(`acct-${chain}`, `The ${chain} account can be read`, false, (e as Error).message.split("\n")[0] ?? "read failed");
    }
  }

  // The blueprint it commits to, when this backend built the agent.
  const local = d.foundry.projects().find((p) => p.kidoAgentId === manifest!.kidoAgentId);
  let blueprint: { projectId: string; revision: number | null; matches: boolean } | null = null;
  if (local) {
    const rec = d.foundry.loadRecord(local.projectId);
    const match = rec.revisions.find((r) => blueprintHash(r) === manifest!.blueprintCommitment);
    blueprint = { projectId: local.projectId, revision: match?.revision ?? null, matches: Boolean(match) };
    add("blueprint", "It commits to a blueprint this Kido built", Boolean(match), match ? `blueprint r${match.revision} (${manifest.blueprintCommitment?.slice(0, 12)}…)` : "no revision with that commitment");
  } else add("blueprint", "It commits to a blueprint", null, `commitment ${manifest.blueprintCommitment?.slice(0, 12)}… (built elsewhere; not checked)`);

  const subs = d.subnames ? await d.subnames(n.name) : [];
  const verified = checks.every((c) => c.ok !== false);
  return {
    name: n.name,
    verified,
    checks,
    agent: { kidoAgentId: manifest.kidoAgentId, chains: manifest.supportedChains ?? [], capabilities: manifest.publicCapabilities ?? [], description: n.records.description ?? null, live: n.records["kido-live"] ?? null, accounts: manifest.accounts ?? {}, amaneAccountId: manifest.amaneAccountId ?? null },
    onchain,
    blueprint,
    specialists: subs,
  } as const;
}

export type { Hex };
