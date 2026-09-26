import { encodeDeployData, encodeFunctionData, erc20Abi, keccak256, toHex, verifyTypedData, type Address, type Hex, type PublicClient } from "viem";
import type { ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import {
  AmaneEvmEndpoint,
  AmaneSuiEndpoint,
  addressToBytes32,
  amaneAccountAbi,
  amaneAccountBytecode,
  signAmane,
  suiObjectToBytes32,
  typedData,
  type AgentLease,
  type Bytes32,
  type PauseAccount,
  type RevokeLease,
  type RootPolicy,
  type TypedDataSigner,
} from "@kido/amane-bridge";
import { CHAINS } from "@kido/registry";
import { compileAmaneAuthority } from "@kido/runtime";
import { isStale } from "@kido/blueprint";
import { authorityEndpoints } from "./endpoints.js";
import { LifecycleError, type Foundry, type ProjectEvent, type ProjectRecord } from "./service.js";

type SuiClient = ConstructorParameters<typeof AmaneSuiEndpoint>[0];
type SuiSigner = Parameters<typeof AmaneSuiEndpoint.create>[0]["relayer"];

/**
 * Wallet-driven deployment of a built agent's Amane authority.
 *
 * The owner's wallet is the only root controller: it deploys the EVM account and sends the EVM
 * install/activate transactions (paying their gas), and signs the one owner policy that every chain
 * endpoint installs. Kido holds only the lease-issuer key (bounded by the issuer caps in that
 * policy) and, for Sui, a gas-paying relayer that cannot change any signed message.
 */
export interface WalletDeployDeps {
  foundry: Foundry;
  evm?: { publicClient: PublicClient };
  sui?: { client: SuiClient; relayer: SuiSigner };
  /** Kido's lease issuer. Absent ⇒ deployment is BLOCKED_ENV. */
  issuer?: TypedDataSigner;
  /** The agent's signing address (its key lives with the runtime, never in a page). */
  agent?: Address;
  now?: () => bigint;
}

type ChainState = { account?: string; deployTx?: string; install?: string; activate?: string };
export interface DeploymentState {
  status: "STARTED" | "ACCOUNTS_READY" | "POLICY_SIGNED" | "ACTIVE";
  owner: Address;
  recovery: { evm?: Address; sui?: string };
  accountId: Hex;
  blueprintRevision: number;
  compiledAt: string;
  issuer: Address;
  agent: Address;
  chains: Partial<Record<ChainId, ChainState>>;
  policy?: RootPolicy;
  lease?: AgentLease;
  leaseId?: Hex;
  ownerSig?: Hex;
}
export interface TxRequest {
  chainId: number;
  to?: Address;
  data: Hex;
  label: string;
}

const enc = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $big: x.toString() } : x)));
const dec = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x)) as T;
/** Typed data for a JSON client: bigints as decimal strings (the client revives them from `types`). */
export const wire = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

const family = (c: ChainId) => CHAINS.find((x) => x.chainId === c)?.family;
const SEPOLIA_ID = 11155111;

export class WalletDeployments {
  constructor(private readonly d: WalletDeployDeps) {}

  private now() {
    return this.d.now ? this.d.now() : BigInt(Math.floor(Date.now() / 1000));
  }
  private load(id: string) {
    const p = this.d.foundry.loadRecord(id);
    return { p, dep: p.deployment ? dec<DeploymentState>(p.deployment) : null };
  }
  private save(p: ProjectRecord, dep: DeploymentState, ...events: Omit<ProjectEvent, "at">[]) {
    p.deployment = enc(dep);
    p.events = [...(p.events ?? []), ...events.map((e) => ({ at: Date.now(), ...e }))];
    this.d.foundry.saveRecord(p);
  }
  private built(p: ProjectRecord): KidoAgentBlueprint {
    const bp = p.revisions.at(-1);
    if (!bp || !p.build || isStale(p.build, bp)) throw new LifecycleError("KIDO_DEPLOY_NOT_BUILT", "build the current blueprint revision before deploying");
    if (bp.authority.provider !== "AMANE") throw new LifecycleError("KIDO_DEPLOY_NO_AMANE", "this blueprint does not use Amane authority; there is nothing to deploy on-chain");
    return bp;
  }
  private need<T>(v: T | undefined, what: string): T {
    if (!v) throw new LifecycleError("BLOCKED_ENV", `${what} is not configured on the Kido backend`);
    return v;
  }

  status(id: string) {
    const { p, dep } = this.load(id);
    return { deployment: dep ? wire(dep) : null, events: p.events ?? [], issuerConfigured: Boolean(this.d.issuer), suiRelayer: Boolean(this.d.sui), evmRpc: Boolean(this.d.evm) };
  }

  /** Step 1: account id; Sui account created by the relayer; the EVM account deploy for the wallet. */
  async start(id: string, owner: Address, recovery: { evm?: Address; sui?: string } = {}): Promise<{ deployment: unknown; transactions: TxRequest[] }> {
    const { p } = this.load(id);
    const bp = this.built(p);
    const issuer = this.need(this.d.issuer, "a lease issuer key (KIDO_ISSUER_KEY)");
    const agent = this.need(this.d.agent, "the agent address (KIDO_AGENT_ADDRESS)");
    const accountId = keccak256(toHex(`kido:${bp.kidoAgentId}:r${bp.revision}:${this.now()}`));
    const dep: DeploymentState = { status: "STARTED", owner, recovery, accountId, blueprintRevision: bp.revision, compiledAt: this.now().toString(), issuer: issuer.address, agent, chains: {} };
    const events: Omit<ProjectEvent, "at">[] = [{ type: "deploy.started", detail: `owner ${owner}; account id ${accountId}` }];
    const transactions: TxRequest[] = [];
    const m = this.d.foundry.manifest;
    for (const chain of bp.chains) {
      if (family(chain) === "sui") {
        const sui = this.need(this.d.sui, "a Sui relayer (KIDO_SUI_RELAYER_KEY)");
        const { endpoint, tx } = await AmaneSuiEndpoint.create({ client: sui.client, packageId: m.sui.packageId, relayer: sui.relayer, accountId, chainRef: m.sui.chainRef as Bytes32, controllers: [owner], threshold: 1 });
        dep.chains[chain] = { account: endpoint.objectId, deployTx: tx };
        events.push({ type: "deploy.account", chain, detail: `Amane account object ${endpoint.objectId} (controller: owner)`, tx });
      } else {
        const ext = m.evm.accountExt ?? fail("the Amane manifest has no evm.accountExt");
        const data = encodeDeployData({ abi: amaneAccountAbi, bytecode: amaneAccountBytecode, args: [accountId, [owner], 1, m.evm.adapterRegistry as Address, ext] });
        dep.chains[chain] = {};
        transactions.push({ chainId: SEPOLIA_ID, data, label: "Deploy the agent's Amane account" });
      }
    }
    if (Object.values(dep.chains).every((c) => c?.account)) dep.status = "ACCOUNTS_READY";
    this.save(p, dep, ...events);
    return { deployment: wire(dep), transactions };
  }

  /** Step 1b: the wallet deployed the EVM account; read it back and check it is the one we asked for. */
  async evmAccount(id: string, txHash: Hex) {
    const { p, dep } = this.load(id);
    if (!dep) throw new LifecycleError("KIDO_DEPLOY_NOT_STARTED", "start the deployment first");
    const client = this.need(this.d.evm, "an Ethereum RPC").publicClient;
    const r = await client.waitForTransactionReceipt({ hash: txHash });
    if (r.status !== "success" || !r.contractAddress) throw new LifecycleError("KIDO_DEPLOY_TX_FAILED", `the deployment transaction ${txHash} did not create a contract`);
    const ep = new AmaneEvmEndpoint(client as never, null as never, r.contractAddress);
    const st = await ep.state();
    if (st.accountId !== dep.accountId || !st.controllers.map((c) => c.toLowerCase()).includes(dep.owner.toLowerCase())) throw new LifecycleError("KIDO_DEPLOY_WRONG_ACCOUNT", "the deployed contract is not this agent's account");
    const chain = (Object.keys(dep.chains) as ChainId[]).find((c) => family(c) === "evm")!;
    dep.chains[chain] = { account: r.contractAddress, deployTx: txHash };
    if (Object.values(dep.chains).every((c) => c?.account)) dep.status = "ACCOUNTS_READY";
    this.save(p, dep, { type: "deploy.account", chain, detail: `Amane account ${r.contractAddress} (core v${await ep.coreVersion()})`, tx: txHash });
    return { deployment: wire(dep) };
  }

  private authority(p: ProjectRecord, dep: DeploymentState) {
    const bp = this.built(p);
    const accounts: Partial<Record<ChainId, Bytes32>> = {};
    const recovery: Partial<Record<ChainId, Bytes32>> = {};
    for (const [chain, s] of Object.entries(dep.chains) as [ChainId, ChainState][]) {
      if (!s.account) throw new LifecycleError("KIDO_DEPLOY_ACCOUNTS_PENDING", `the ${chain} account is not deployed yet`);
      accounts[chain] = family(chain) === "sui" ? suiObjectToBytes32(s.account) : addressToBytes32(s.account as Address);
      const r = family(chain) === "sui" ? (dep.recovery.sui ? suiObjectToBytes32(dep.recovery.sui) : undefined) : addressToBytes32(dep.recovery.evm ?? dep.owner);
      if (r) recovery[chain] = r;
    }
    const endpoints = authorityEndpoints(bp, this.d.foundry.manifest, this.d.foundry.registry, accounts, undefined, recovery);
    const a = compileAmaneAuthority(bp, endpoints, { controllers: [dep.owner], issuer: dep.issuer, agent: dep.agent, now: BigInt(dep.compiledAt), accountId: dep.accountId as Bytes32 });
    if (!a.ok) throw new LifecycleError("KIDO_DEPLOY_AUTHORITY", a.blockers.join("; "));
    return a;
  }

  /** Step 2: the one owner policy for every endpoint, as EIP-712 typed data for the wallet. */
  policy(id: string) {
    const { p, dep } = this.load(id);
    if (!dep) throw new LifecycleError("KIDO_DEPLOY_NOT_STARTED", "start the deployment first");
    const a = this.authority(p, dep);
    dep.policy = a.policy;
    this.save(p, dep);
    return { typedData: wire(typedData("RootPolicy", a.policy)), summary: { endpoints: a.policy.endpoints.length, allowedActions: a.policy.allowedActions, crossChainTotal: wire(a.crossChainTotal) } };
  }

  /** Step 3: verify the owner's signature, issue the lease, and install/activate on every chain. */
  async submitPolicy(id: string, signature: Hex): Promise<{ deployment: unknown; transactions: TxRequest[] }> {
    const { p, dep } = this.load(id);
    if (!dep?.policy) throw new LifecycleError("KIDO_DEPLOY_NO_POLICY", "fetch the policy to sign first");
    const td = typedData("RootPolicy", dep.policy);
    const ok = await verifyTypedData({ address: dep.owner, ...(td as object), signature } as never);
    if (!ok) throw new LifecycleError("KIDO_DEPLOY_BAD_SIGNATURE", "the signature is not the owner's signature over this policy");
    const a = this.authority(p, dep);
    const leaseId = keccak256(toHex(`kido:lease:${dep.accountId}:${this.now()}`));
    const lease = a.lease(leaseId, this.now());
    const issuer = this.need(this.d.issuer, "a lease issuer key (KIDO_ISSUER_KEY)");
    const leaseSig = await signAmane(issuer, "AgentLease", lease);
    Object.assign(dep, { ownerSig: signature, lease, leaseId, status: "POLICY_SIGNED" });
    const events: Omit<ProjectEvent, "at">[] = [{ type: "deploy.policy.signed", detail: `owner signed the policy for ${dep.policy.endpoints.length} endpoint(s); lease ${leaseId} issued` }];
    const transactions: TxRequest[] = [];
    for (const [chain, s] of Object.entries(dep.chains) as [ChainId, ChainState][]) {
      if (family(chain) === "sui") {
        const sui = this.need(this.d.sui, "a Sui relayer");
        const ep = new AmaneSuiEndpoint(sui.client, this.d.foundry.manifest.sui.packageId, s.account!, sui.relayer);
        const install = await ep.installPolicy(dep.policy, [signature]);
        if (install.kind !== "EXECUTED") throw new LifecycleError("KIDO_DEPLOY_INSTALL_REFUSED", `Sui refused the policy: ${install.kind === "REJECTED_BY_AMANE" ? install.code : install.kind}`);
        const activate = await ep.activateLease(lease, leaseSig);
        if (activate.kind !== "EXECUTED") throw new LifecycleError("KIDO_DEPLOY_LEASE_REFUSED", `Sui refused the lease: ${activate.kind === "REJECTED_BY_AMANE" ? activate.code : activate.kind}`);
        s.install = install.tx;
        s.activate = activate.tx;
        events.push({ type: "deploy.policy.installed", chain, detail: "policy installed and lease activated", tx: activate.tx });
      } else {
        transactions.push({ chainId: SEPOLIA_ID, to: s.account as Address, data: encodeFunctionData({ abi: amaneAccountAbi, functionName: "installPolicy", args: [dep.policy, [signature]] as never }), label: "Install the owner policy" });
        transactions.push({ chainId: SEPOLIA_ID, to: s.account as Address, data: encodeFunctionData({ abi: amaneAccountAbi, functionName: "activateLease", args: [lease, leaseSig] as never }), label: "Activate the agent lease" });
      }
    }
    this.save(p, dep, ...events);
    return { deployment: wire(dep), transactions };
  }

  /** Step 4: read every endpoint back; ACTIVE only when each has the policy and an active lease. */
  async confirm(id: string) {
    const { p, dep } = this.load(id);
    if (!dep?.leaseId) throw new LifecycleError("KIDO_DEPLOY_NO_LEASE", "sign the policy first");
    const rt = await this.runtime(id);
    const ready = rt.chains.every((c) => c.policyVersion !== null && c.policyVersion > 0 && c.leaseStatus === 1);
    if (ready && dep.status !== "ACTIVE") {
      dep.status = "ACTIVE";
      this.save(p, dep, { type: "deploy.active", detail: `policy installed and lease active on ${rt.chains.map((c) => c.chain).join(", ")}` });
    }
    return { active: ready, runtime: rt };
  }

  /** Live account state on every chain, read from the chain (not from Kido's records). */
  async runtime(id: string) {
    const { p, dep } = this.load(id);
    const bp = p.revisions.at(-1);
    if (!dep) return { deployed: false, status: null, chains: [] as RuntimeChain[] };
    const chains: RuntimeChain[] = [];
    for (const [chain, s] of Object.entries(dep.chains) as [ChainId, ChainState][]) {
      const base: RuntimeChain = { chain, account: s.account ?? null, policyVersion: null, paused: null, pauseEpoch: null, leaseStatus: null, balances: [], error: null };
      if (!s.account) {
        chains.push(base);
        continue;
      }
      try {
        const assets = (bp?.assets ?? []).filter((x) => x.chain === chain);
        if (family(chain) === "sui") {
          const sui = this.need(this.d.sui, "a Sui client");
          const ep = new AmaneSuiEndpoint(sui.client, this.d.foundry.manifest.sui.packageId, s.account, sui.relayer);
          const tokens = (this.d.foundry.manifest.sui.tokens ?? {}) as unknown as Record<string, { coinType?: string }>;
          chains.push({
            ...base,
            policyVersion: Number(await ep.policyVersion()),
            paused: await ep.isPaused(),
            pauseEpoch: Number(await ep.pauseEpoch()),
            leaseStatus: dep.leaseId ? await ep.leaseStatus(dep.leaseId as Bytes32) : null,
            balances: await Promise.all(assets.filter((x) => tokens[x.symbol]?.coinType).map(async (x) => ({ symbol: x.symbol, amount: (await ep.vaultBalance(tokens[x.symbol]!.coinType!)).toString(), decimals: x.decimals }))),
          });
        } else {
          const client = this.need(this.d.evm, "an Ethereum RPC").publicClient;
          const ep = new AmaneEvmEndpoint(client as never, null as never, s.account as Address);
          const st = await ep.state();
          chains.push({
            ...base,
            policyVersion: Number(st.policyVersion),
            paused: st.paused,
            pauseEpoch: Number(st.pauseEpoch),
            leaseStatus: dep.leaseId ? await ep.leaseStatus(dep.leaseId as Bytes32) : null,
            balances: await Promise.all(assets.map(async (x) => ({ symbol: x.symbol, amount: ((await client.readContract({ address: x.ref as Address, abi: erc20Abi, functionName: "balanceOf", args: [s.account as Address] })) as bigint).toString(), decimals: x.decimals }))),
          });
        }
      } catch (e) {
        chains.push({ ...base, error: (e as Error).message.split("\n")[0] ?? "read failed" });
      }
    }
    return { deployed: true, status: dep.status, accountId: dep.accountId, owner: dep.owner, leaseId: dep.leaseId ?? null, chains };
  }

  /**
   * Reality Lab: every Amane contract and package the manifest names, checked on the live chains
   * (bytecode present on Ethereum, object present and immutable-or-owned on Sui), plus, for a
   * deployed agent, a refusal probe: a stranger's call to the account is simulated against the real
   * contract and must revert. Nothing is signed or sent.
   */
  async reality(id?: string) {
    const m = this.d.foundry.manifest as unknown as { evm: Record<string, unknown>; sui: Record<string, unknown> };
    const collect = (node: unknown, path: string, re: RegExp, out: { label: string; ref: string }[]) => {
      if (typeof node === "string") {
        if (re.test(node) && !out.some((o) => o.ref.toLowerCase() === node.toLowerCase())) out.push({ label: path, ref: node });
      } else if (Array.isArray(node)) node.forEach((v, i) => collect(v, `${path}[${(v as { name?: string })?.name ?? i}]`, re, out));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) if (!/Tx$|Digest$|adapterId$|chainRef$|sourceCommit$/.test(k)) collect(v, path ? `${path}.${k}` : k, re, out);
    };
    const evmRefs: { label: string; ref: string }[] = [];
    const suiRefs: { label: string; ref: string }[] = [];
    collect(m.evm, "", /^0x[0-9a-fA-F]{40}$/, evmRefs);
    collect(m.sui, "", /^0x[0-9a-f]{64}$/, suiRefs);
    type Probe = { chain: ChainId; label: string; ref: string; ok: boolean; detail: string };
    const probes: Probe[] = [];
    const heads: { chain: ChainId; head: string | null; error: string | null }[] = [];
    const evmChain = "ethereum-sepolia" as ChainId;
    const suiChain = "sui-testnet" as ChainId;
    if (this.d.evm) {
      const c = this.d.evm.publicClient;
      try {
        heads.push({ chain: evmChain, head: (await c.getBlockNumber()).toString(), error: null });
      } catch (e) {
        heads.push({ chain: evmChain, head: null, error: (e as Error).message.split("\n")[0] ?? "read failed" });
      }
      await Promise.all(evmRefs.map(async (r) => {
        try {
          const code = await c.getCode({ address: r.ref as Address });
          probes.push({ chain: evmChain, ...r, ok: Boolean(code && code !== "0x"), detail: code && code !== "0x" ? `${(code.length - 2) / 2} bytes of code` : "no code at this address (an EOA or a token list entry)" });
        } catch (e) {
          probes.push({ chain: evmChain, ...r, ok: false, detail: (e as Error).message.split("\n")[0] ?? "read failed" });
        }
      }));
    } else heads.push({ chain: evmChain, head: null, error: "no Ethereum RPC configured" });
    if (this.d.sui) {
      const c = this.d.sui.client as unknown as { core: { getObjects(o: { objectIds: string[] }): Promise<{ objects: ({ objectId: string; owner: unknown; type: string } | Error)[] }> } };
      try {
        const res = await c.core.getObjects({ objectIds: suiRefs.map((r) => r.ref) });
        heads.push({ chain: suiChain, head: "reachable", error: null });
        res.objects.forEach((o, i) => {
          const r = suiRefs[i]!;
          if (o instanceof Error) probes.push({ chain: suiChain, ...r, ok: /emitter/i.test(r.label), detail: /emitter/i.test(r.label) ? "emitter identity (wrapped in the adapter or an address, not a standalone object)" : o.message.split("\n")[0] ?? "not found" });
          else probes.push({ chain: suiChain, ...r, ok: true, detail: `${o.type === "package" ? "package" : o.type.split("<")[0]}; owner ${typeof o.owner === "object" && o.owner ? Object.keys(o.owner as object)[0] ?? "?" : String(o.owner)}` });
        });
      } catch (e) {
        heads.push({ chain: suiChain, head: null, error: (e as Error).message.split("\n")[0] ?? "read failed" });
      }
    } else heads.push({ chain: suiChain, head: null, error: "no Sui client configured (KIDO_SUI_RELAYER_KEY)" });

    const refusals: { chain: ChainId; probe: string; refused: boolean; detail: string }[] = [];
    const dep = id ? this.load(id).dep : null;
    if (dep && this.d.evm) {
      const acct = dep.chains[evmChain]?.account as Address | undefined;
      if (acct) {
        const stranger = `0x${keccak256(toHex(`kido:reality:${Date.now()}`)).slice(26)}` as Address;
        const probe = async (name: string, data: Hex) => {
          try {
            await this.d.evm!.publicClient.call({ account: stranger, to: acct, data });
            refusals.push({ chain: evmChain, probe: name, refused: false, detail: "the call did not revert" });
          } catch (e) {
            refusals.push({ chain: evmChain, probe: name, refused: true, detail: ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0] ?? "reverted" });
          }
        };
        await probe("stranger releases a reservation", encodeFunctionData({ abi: amaneAccountAbi, functionName: "releaseReservation", args: [keccak256(toHex("kido:reality:reservation"))] }));
      }
    }
    return { heads, probes: probes.sort((a, b) => a.chain.localeCompare(b.chain) || a.label.localeCompare(b.label)), refusals, deployed: Boolean(dep), accounts: dep ? Object.fromEntries(Object.entries(dep.chains).map(([c, s]) => [c, s?.account ?? null])) : {} };
  }

  /** Owner controls: typed data for pause (one controller), unpause (threshold) or revoke (the lease). */
  async controlPrepare(id: string, op: "pause" | "revoke") {
    const { dep } = this.load(id);
    if (!dep?.leaseId) throw new LifecycleError("KIDO_DEPLOY_NOT_ACTIVE", "the agent is not deployed");
    const rt = await this.runtime(id);
    const deadline = this.now() + 600n;
    if (op === "revoke") {
      const msg: RevokeLease = { accountId: dep.accountId as Bytes32, leaseId: dep.leaseId as Bytes32 };
      return { messages: [{ chain: "all", primaryType: "RevokeLease", message: wire(msg), typedData: wire(typedData("RevokeLease", msg)) }] };
    }
    return {
      messages: rt.chains.map((c) => {
        const msg: PauseAccount = { accountId: dep.accountId as Bytes32, pauseEpoch: BigInt(c.pauseEpoch ?? 0), pauseId: keccak256(toHex(`kido:pause:${dep.accountId}:${c.chain}:${this.now()}`)), deadline };
        return { chain: c.chain, primaryType: "PauseAccount", message: wire(msg), typedData: wire(typedData("PauseAccount", msg)) };
      }),
    };
  }

  /** Relays a signed owner control on each chain (Sui by the relayer; EVM returned for the wallet). */
  async controlSubmit(id: string, op: "pause" | "revoke", signed: { chain: string; message: Record<string, unknown>; signature: Hex }[]): Promise<{ transactions: TxRequest[]; results: unknown[] }> {
    const { p, dep } = this.load(id);
    if (!dep) throw new LifecycleError("KIDO_DEPLOY_NOT_ACTIVE", "the agent is not deployed");
    const transactions: TxRequest[] = [];
    const results: unknown[] = [];
    const events: Omit<ProjectEvent, "at">[] = [];
    for (const [chain, s] of Object.entries(dep.chains) as [ChainId, ChainState][]) {
      const item = signed.find((x) => x.chain === chain || x.chain === "all");
      if (!item || !s.account) continue;
      const pt = op === "pause" ? "PauseAccount" : "RevokeLease";
      const msg = revive(pt, item.message);
      const ok = await verifyTypedData({ address: dep.owner, ...(typedData(pt as never, msg as never) as object), signature: item.signature } as never);
      if (!ok) throw new LifecycleError("KIDO_CONTROL_BAD_SIGNATURE", `the ${op} signature is not the owner's`);
      if (family(chain) === "sui") {
        const sui = this.need(this.d.sui, "a Sui relayer");
        const ep = new AmaneSuiEndpoint(sui.client, this.d.foundry.manifest.sui.packageId, s.account, sui.relayer);
        const out = op === "pause" ? await ep.pause(msg as unknown as PauseAccount, item.signature) : await ep.revokeLease(msg as unknown as RevokeLease, item.signature);
        results.push({ ...out, chain });
        events.push({ type: `control.${op}`, chain, detail: out.kind === "EXECUTED" ? `${op} executed` : `${op} refused: ${JSON.stringify(out)}`, ...(out.kind === "EXECUTED" ? { tx: out.tx } : {}) });
      } else {
        const data = op === "pause" ? encodeFunctionData({ abi: amaneAccountAbi, functionName: "pause", args: [msg, item.signature] as never }) : encodeFunctionData({ abi: amaneAccountAbi, functionName: "revokeLease", args: [msg, item.signature] as never });
        transactions.push({ chainId: SEPOLIA_ID, to: s.account as Address, data, label: op === "pause" ? "Pause the agent's account" : "Revoke the agent's lease" });
        events.push({ type: `control.${op}.signed`, chain, detail: `${op} signed; sent from the owner's wallet` });
      }
    }
    this.save(p, dep, ...events);
    return { transactions, results };
  }

  /** The wallet reports an EVM transaction it sent (install, activate, pause, revoke). */
  record(id: string, chain: string, label: string, tx: Hex) {
    const { p, dep } = this.load(id);
    if (!dep) throw new LifecycleError("KIDO_DEPLOY_NOT_STARTED", "start the deployment first");
    this.save(p, dep, { type: "wallet.tx", chain, detail: label, tx });
    return { ok: true };
  }

  events(id: string) {
    return { events: this.d.foundry.loadRecord(id).events ?? [] };
  }
}

export interface RuntimeChain {
  chain: ChainId;
  account: string | null;
  policyVersion: number | null;
  paused: boolean | null;
  pauseEpoch: number | null;
  leaseStatus: number | null;
  balances: { symbol: string; amount: string; decimals: number }[];
  error: string | null;
}

/** Owner control messages arrive with decimal strings; restore the bigint fields. */
function revive(pt: string, m: Record<string, unknown>): Record<string, unknown> {
  if (pt === "PauseAccount") return { ...m, pauseEpoch: BigInt(String(m.pauseEpoch)), deadline: BigInt(String(m.deadline)) };
  return m;
}

function fail(msg: string): never {
  throw new LifecycleError("BLOCKED_ENV", msg);
}
