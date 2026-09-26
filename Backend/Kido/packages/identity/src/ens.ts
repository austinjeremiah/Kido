import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  labelhash,
  namehash,
  parseAbi,
  stringToBytes,
  toBytes,
  toHex,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import ETHRegistrar from "../abi/ETHRegistrar.json" with { type: "json" };
import ETHRegistry from "../abi/ETHRegistry.json" with { type: "json" };
import PermissionedResolverImpl from "../abi/PermissionedResolverImpl.json" with { type: "json" };
import UserRegistryImpl from "../abi/UserRegistryImpl.json" with { type: "json" };
import VerifiableFactory from "../abi/VerifiableFactory.json" with { type: "json" };
import UniversalResolverV2 from "../abi/UniversalResolverV2.json" with { type: "json" };
import MockUSDC from "../abi/MockUSDC.json" with { type: "json" };
import type { AgentIdentityProvider, IdentityCapability, IdentityReceipt, IdentityResolution, IdentityStatus, PublicRecords } from "./core.js";

const TEXT_ABI = parseAbi(["function text(bytes32 node, string key) view returns (string)", "function addr(bytes32 node) view returns (address)"]);
type Wallet = WalletClient<Transport, Chain, Account>;

export interface EnsDeployment {
  ethRegistrar: Address;
  ethRegistry: Address;
  universalResolver: Address;
  verifiableFactory: Address;
  permissionedResolverImpl: Address;
  userRegistryImpl: Address;
  mockUsdc: Address;
}

/** ENSIP-9 / ENSIP-11 coin types: Ethereum's own (60), an EVM chain by id, and Sui (SLIP-44 784). */
export const ENS_COIN = { eth: 60n, evmChain: (chainId: number | bigint) => 0x80000000n | BigInt(chainId), sui: 784n } as const;

export const KIDO_RECORD_KEYS = ["agent-context", "kido-agent-id", "kido-agent-role", "kido-live", "description", "url", "avatar", "agent-endpoint[web]", "agent-endpoint[mcp]", "agent-endpoint[a2a]"];

// EAC role values (ENSv2 contracts-v2@71a3b733). Admin roles sit 128 bits higher.
const R = (n: number) => 1n << BigInt(n);
const withAdmin = (r: bigint) => r | (r << 128n);
const RESOLVER_OWNER_ROLES = withAdmin(R(0) | R(4) | R(8) | R(20) | R(24) | R(28));
const USER_REGISTRY_OWNER_ROLES = withAdmin(R(0) | R(8) | R(12) | R(16) | R(20) | R(24));
const SUBNAME_OWNER_ROLES = R(20) | R(24);

/** DNS wire-format encoding used by ENSv2 setters and the UniversalResolver. */
export function dnsEncode(name: string): Hex {
  const parts = name.split(".").filter(Boolean).map((label) => {
    const b = stringToBytes(label);
    if (b.length > 63) throw new Error(`label too long: ${label}`);
    return concat([toHex(b.length, { size: 1 }), toHex(b)]);
  });
  return concat([...parts, "0x00"]);
}

/**
 * ENSv2 (Sepolia beta) identity adapter. Registration pays in the ENSv2 MockUSDC; each agent name
 * gets its own PermissionedResolver instance so a scoped record manager for one agent cannot
 * write another agent's records.
 */
export class EnsIdentityAdapter implements AgentIdentityProvider {
  readonly providerId = "ens";
  readonly chain = "ethereum-sepolia" as const;
  private readonly resolvers = new Map<string, Address>();

  constructor(readonly publicClient: PublicClient, readonly wallet: Wallet | null, readonly d: EnsDeployment, readonly opts: { durationSeconds?: bigint } = {}) {}

  capabilities(): IdentityCapability[] {
    const base: IdentityCapability[] = ["RESOLVE", "TEXT_RECORDS", "EXPIRY"];
    return this.wallet ? [...base, "REGISTER", "SUBNAME", "SCOPED_RECORD_MANAGER", "REVOKE"] : base;
  }

  async resolve(name: string, keys: string[] = KIDO_RECORD_KEYS): Promise<IdentityResolution> {
    const node = namehash(name);
    const dns = dnsEncode(name);
    const records: Record<string, string> = {};
    let found = false;
    for (const key of keys) {
      try {
        const [bytes] = (await this.publicClient.readContract({
          address: this.d.universalResolver,
          abi: UniversalResolverV2.abi,
          functionName: "resolve",
          args: [dns, encodeFunctionData({ abi: TEXT_ABI, functionName: "text", args: [node, key] })],
        })) as [Hex, Address];
        found = true;
        const v = decodeFunctionResult({ abi: TEXT_ABI, functionName: "text", data: bytes }) as string;
        if (v) records[key] = v;
      } catch {
        /* resolver not found or key unsupported */
      }
    }
    let address: string | null = null;
    try {
      const [bytes] = (await this.publicClient.readContract({ address: this.d.universalResolver, abi: UniversalResolverV2.abi, functionName: "resolve", args: [dns, encodeFunctionData({ abi: TEXT_ABI, functionName: "addr", args: [node] })] })) as [Hex, Address];
      const a = decodeFunctionResult({ abi: TEXT_ABI, functionName: "addr", data: bytes }) as Address;
      found = true;
      address = a === zeroAddress ? null : a;
    } catch {
      /* no address record */
    }
    return { providerId: this.providerId, name, found, address, records, kidoAgentId: records["kido-agent-id"] ?? null, resolvedAt: Date.now() };
  }

  /** The owner of a second-level .eth name in the ENSv2 registry (null when unregistered or expired). */
  async owner(name: string): Promise<Address | null> {
    const labels = name.split(".");
    if (labels.length !== 2 || labels[1] !== "eth") return null;
    try {
      const tokenId = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "getTokenId", args: [BigInt(labelhash(labels[0]!))] })) as bigint;
      const o = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "ownerOf", args: [tokenId] })) as Address;
      return o === zeroAddress ? null : o;
    } catch {
      return null;
    }
  }

  async inspect(name: string): Promise<IdentityStatus> {
    const r = await this.resolve(name);
    let expiresAt: number | null = null;
    const labels = name.split(".");
    if (labels.length === 2) {
      try {
        const expiry = Number(await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "getExpiry", args: [BigInt(labelhash(labels[0]!))] })) * 1000;
        // Expiry 0 means the name was never registered; a past expiry means it lapsed.
        expiresAt = expiry > Date.now() ? expiry : null;
      } catch {
        /* unregistered */
      }
    }
    // For subnames, a resolver found at a non-zero offset belongs to a parent (wildcard fallback):
    // the name itself is not registered.
    let ownResolver = false;
    if (labels.length > 2) {
      try {
        const [resolver, , offset] = (await this.publicClient.readContract({ address: this.d.universalResolver, abi: UniversalResolverV2.abi, functionName: "findResolver", args: [dnsEncode(name)] })) as [Address, Hex, bigint];
        ownResolver = resolver !== zeroAddress && offset === 0n;
      } catch {
        /* no resolver */
      }
    }
    const registered = labels.length > 2 ? ownResolver : r.found || expiresAt !== null;
    return { providerId: this.providerId, name, registered, records: registered ? r.records : {}, expiresAt, revoked: registered && !r.records["agent-context"] };
  }

  /** Deploys a dedicated resolver for `name`, optionally writing records in the same transaction. */
  async deployResolver(name: string, records: PublicRecords = {}): Promise<{ resolver: Address; tx: Hex }> {
    const w = this.requireWallet();
    const salt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(toHex("OwnedResolver")), w.account.address, BigInt(namehash(name))])));
    const dns = dnsEncode(name);
    const calls = Object.entries(records).map(([k, v]) => encodeFunctionData({ abi: PermissionedResolverImpl.abi, functionName: "setText", args: [dns, k, v] }));
    const init = encodeFunctionData({ abi: PermissionedResolverImpl.abi, functionName: "initialize", args: [[{ account: w.account.address, roleBitmap: RESOLVER_OWNER_ROLES }], calls] });
    const { result, request } = await this.publicClient.simulateContract({ address: this.d.verifiableFactory, abi: VerifiableFactory.abi, functionName: "deployProxy", args: [this.d.permissionedResolverImpl, salt, init], account: w.account });
    const tx = await w.writeContract(request as never);
    await this.confirm(tx);
    const resolver = result as Address;
    this.resolvers.set(name, resolver);
    return { resolver, tx };
  }

  /** Registers `<label>.eth` for `owner` through commit-reveal, paying in ENSv2 MockUSDC. */
  async register(label: string, owner: string): Promise<IdentityReceipt> {
    const w = this.requireWallet();
    const name = `${label}.eth`;
    const txs: Hex[] = [];
    try {
      const available = await this.publicClient.readContract({ address: this.d.ethRegistrar, abi: ETHRegistrar.abi, functionName: "isAvailable", args: [label] });
      if (!available) return { providerId: this.providerId, chain: this.chain, operation: "REGISTER", name, txs, status: "FAILED", detail: "name not available" };
      const duration = this.opts.durationSeconds ?? 2_419_200n;
      const { resolver, tx: rtx } = await this.deployResolver(name);
      txs.push(rtx);
      const [base, premium] = (await this.publicClient.readContract({ address: this.d.ethRegistrar, abi: ETHRegistrar.abi, functionName: "getRegisterPrice", args: [label, duration, this.d.mockUsdc] })) as [bigint, bigint];
      const cost = base + premium;
      txs.push(await this.send(this.d.mockUsdc, MockUSDC.abi, "mint", [w.account.address, cost]));
      txs.push(await this.send(this.d.mockUsdc, MockUSDC.abi, "approve", [this.d.ethRegistrar, cost]));
      const secret = keccak256(toBytes(`${name}|${Date.now()}|${Math.random()}`));
      const referrer = `0x${"00".repeat(32)}` as Hex;
      const commitment = await this.publicClient.readContract({ address: this.d.ethRegistrar, abi: ETHRegistrar.abi, functionName: "makeCommitment", args: [label, owner, secret, zeroAddress, resolver, duration, referrer] });
      txs.push(await this.send(this.d.ethRegistrar, ETHRegistrar.abi, "commit", [commitment]));
      const minAge = Number(await this.publicClient.readContract({ address: this.d.ethRegistrar, abi: ETHRegistrar.abi, functionName: "MIN_COMMITMENT_AGE" }));
      await this.waitForChainTime(minAge + 3);
      txs.push(await this.send(this.d.ethRegistrar, ETHRegistrar.abi, "register", [label, owner, secret, zeroAddress, resolver, duration, this.d.mockUsdc, referrer]));
      return { providerId: this.providerId, chain: this.chain, operation: "REGISTER", name, txs, status: "CONFIRMED", detail: `resolver ${resolver}` };
    } catch (err) {
      return { providerId: this.providerId, chain: this.chain, operation: "REGISTER", name, txs, status: "FAILED", detail: (err as Error).message.split("\n")[0] };
    }
  }

  /** Creates `<label>.<parent>` with its own resolver and the given public records. */
  async createSubIdentity(parent: string, label: string, records: PublicRecords): Promise<IdentityReceipt> {
    const w = this.requireWallet();
    const name = `${label}.${parent}`;
    const parentLabel = parent.replace(/\.eth$/, "");
    const txs: Hex[] = [];
    try {
      let userRegistry = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "getSubregistry", args: [parentLabel] })) as Address;
      if (userRegistry === zeroAddress) {
        const salt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(toHex("UserRegistry")), namehash(parent), 1n])));
        const init = encodeFunctionData({ abi: UserRegistryImpl.abi, functionName: "initialize", args: [[{ account: w.account.address, roleBitmap: USER_REGISTRY_OWNER_ROLES }]] });
        const { result, request } = await this.publicClient.simulateContract({ address: this.d.verifiableFactory, abi: VerifiableFactory.abi, functionName: "deployProxy", args: [this.d.userRegistryImpl, salt, init], account: w.account });
        const tx = await w.writeContract(request as never);
        await this.confirm(tx);
        txs.push(tx);
        userRegistry = result as Address;
        txs.push(await this.send(this.d.ethRegistry, ETHRegistry.abi, "setSubregistry", [BigInt(labelhash(parentLabel)), userRegistry]));
        txs.push(await this.send(userRegistry, UserRegistryImpl.abi, "setParent", [this.d.ethRegistry, parentLabel]));
      }
      const { resolver, tx: rtx } = await this.deployResolver(name, records);
      txs.push(rtx);
      const expiry = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "getExpiry", args: [BigInt(labelhash(parentLabel))] })) as bigint;
      txs.push(await this.send(userRegistry, UserRegistryImpl.abi, "register", [label, w.account.address, zeroAddress, resolver, SUBNAME_OWNER_ROLES, expiry]));
      return { providerId: this.providerId, chain: this.chain, operation: "SUBNAME", name, txs, status: "CONFIRMED", detail: `resolver ${resolver} registry ${userRegistry}` };
    } catch (err) {
      return { providerId: this.providerId, chain: this.chain, operation: "SUBNAME", name, txs, status: "FAILED", detail: (err as Error).message.split("\n")[0] };
    }
  }

  /** The registry holding the children of `name` ("eth" → the ETH registry); zero when none exists yet. */
  async registryOf(name: string): Promise<Address> {
    const labels = name.split(".").filter(Boolean);
    if (labels.at(-1) !== "eth") throw new Error(`${name} is not under .eth`);
    let reg: Address = this.d.ethRegistry;
    for (const label of labels.slice(0, -1).reverse()) {
      reg = (await this.publicClient.readContract({ address: reg, abi: UserRegistryImpl.abi, functionName: "getSubregistry", args: [label] })) as Address;
      if (reg === zeroAddress) return zeroAddress;
    }
    return reg;
  }

  /** Ensures `name` has its own registry for children (a UserRegistry the wallet administers). */
  private async ensureSubregistry(name: string, txs: Hex[]): Promise<Address> {
    const existing = await this.registryOf(name);
    if (existing !== zeroAddress) return existing;
    const w = this.requireWallet();
    const [label, ...rest] = name.split(".");
    const parentReg = await this.registryOf(rest.join("."));
    if (parentReg === zeroAddress) throw new Error(`${rest.join(".")} has no registry`);
    const salt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(toHex("UserRegistry")), namehash(name), 1n])));
    const init = encodeFunctionData({ abi: UserRegistryImpl.abi, functionName: "initialize", args: [[{ account: w.account.address, roleBitmap: USER_REGISTRY_OWNER_ROLES }]] });
    const { result, request } = await this.publicClient.simulateContract({ address: this.d.verifiableFactory, abi: VerifiableFactory.abi, functionName: "deployProxy", args: [this.d.userRegistryImpl, salt, init], account: w.account });
    const tx = await w.writeContract(request as never);
    await this.confirm(tx);
    txs.push(tx);
    const reg = result as Address;
    const tokenId = (await this.publicClient.readContract({ address: parentReg, abi: UserRegistryImpl.abi, functionName: "findTokenId", args: [label] })) as bigint;
    txs.push(await this.send(parentReg, UserRegistryImpl.abi, "setSubregistry", [tokenId, reg]));
    txs.push(await this.send(reg, UserRegistryImpl.abi, "setParent", [parentReg, label]));
    return reg;
  }

  /**
   * Publishes `name` at any depth: creates any missing registry above it, deploys its own resolver
   * holding the text records and multichain addresses (ENSIP-9/11 coin types), and registers it
   * to the wallet until the root name expires. An existing name only has its records rewritten.
   */
  async publishName(name: string, records: PublicRecords, addresses: { coinType: bigint; address: Hex }[] = [], opts: { withSubregistry?: boolean; resolver?: Address } = {}): Promise<IdentityReceipt & { resolver?: Address; registry?: Address }> {
    const w = this.requireWallet();
    const txs: Hex[] = [];
    const dns = dnsEncode(name);
    const calls = [
      ...Object.entries(records).map(([k, v]) => encodeFunctionData({ abi: PermissionedResolverImpl.abi, functionName: "setText", args: [dns, k, v] })),
      ...addresses.map((a) => encodeFunctionData({ abi: PermissionedResolverImpl.abi, functionName: "setAddress", args: [dns, a.coinType, a.address] })),
    ];
    try {
      const [label, ...rest] = name.split(".");
      const parent = rest.join(".");
      const parentReg = await this.ensureSubregistry(parent, txs);
      const owner = (await this.publicClient.readContract({ address: parentReg, abi: UserRegistryImpl.abi, functionName: "findOwner", args: [label] })) as Address;
      if (owner !== zeroAddress) {
        // Already registered: rewrite its records on its resolver.
        const resolver = (await this.publicClient.readContract({ address: parentReg, abi: UserRegistryImpl.abi, functionName: "getResolver", args: [label] })) as Address;
        if (resolver === zeroAddress) throw new Error(`${name} has no resolver`);
        if (calls.length) txs.push(await this.send(resolver, PermissionedResolverImpl.abi, "multicall", [calls]));
        const registry = opts.withSubregistry ? await this.ensureSubregistry(name, txs) : undefined;
        return { providerId: this.providerId, chain: this.chain, operation: "PUBLISH_RECORDS", name, txs, status: "CONFIRMED", detail: `records updated on ${resolver}`, resolver, ...(registry ? { registry } : {}) };
      }
      let resolver: Address;
      if (opts.resolver) {
        // An existing resolver (e.g. an offchain CCIP-read resolver) answers for this name.
        resolver = opts.resolver;
      } else {
        const salt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(toHex("OwnedResolver")), w.account.address, BigInt(namehash(name))])));
        const init = encodeFunctionData({ abi: PermissionedResolverImpl.abi, functionName: "initialize", args: [[{ account: w.account.address, roleBitmap: RESOLVER_OWNER_ROLES }], calls] });
        const sim = await this.publicClient.simulateContract({ address: this.d.verifiableFactory, abi: VerifiableFactory.abi, functionName: "deployProxy", args: [this.d.permissionedResolverImpl, salt, init], account: w.account });
        const rtx = await w.writeContract(sim.request as never);
        await this.confirm(rtx);
        txs.push(rtx);
        resolver = sim.result as Address;
      }
      this.resolvers.set(name, resolver);
      const root = name.split(".").slice(-2, -1)[0]!;
      const rootToken = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "findTokenId", args: [root] })) as bigint;
      const expiry = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "getExpiry", args: [rootToken] })) as bigint;
      // Owner roles on the name itself, so it can hold its own registry for children.
      txs.push(await this.send(parentReg, UserRegistryImpl.abi, "register", [label, w.account.address, zeroAddress, resolver, opts.withSubregistry ? USER_REGISTRY_OWNER_ROLES : SUBNAME_OWNER_ROLES, expiry]));
      const registry = opts.withSubregistry ? await this.ensureSubregistry(name, txs) : undefined;
      return { providerId: this.providerId, chain: this.chain, operation: "SUBNAME", name, txs, status: "CONFIRMED", detail: `resolver ${resolver}`, resolver, ...(registry ? { registry } : {}) };
    } catch (err) {
      return { providerId: this.providerId, chain: this.chain, operation: "SUBNAME", name, txs, status: "FAILED", detail: (err as Error).message.split("\n")[0] };
    }
  }

  /** Multichain address records on a name (ENSIP-9 coin types). */
  async addresses(name: string, coinTypes: bigint[]): Promise<Record<string, Hex | null>> {
    const node = namehash(name);
    const dns = dnsEncode(name);
    const ADDR = parseAbi(["function addr(bytes32 node, uint256 coinType) view returns (bytes)"]);
    const out: Record<string, Hex | null> = {};
    for (const ct of coinTypes) {
      try {
        const [bytes] = (await this.publicClient.readContract({ address: this.d.universalResolver, abi: UniversalResolverV2.abi, functionName: "resolve", args: [dns, encodeFunctionData({ abi: ADDR, functionName: "addr", args: [node, ct] })] })) as [Hex, Address];
        const v = decodeFunctionResult({ abi: ADDR, functionName: "addr", data: bytes }) as Hex;
        out[ct.toString()] = v && v !== "0x" ? v : null;
      } catch {
        out[ct.toString()] = null;
      }
    }
    return out;
  }

  async publishRecords(name: string, records: PublicRecords): Promise<IdentityReceipt> {
    const resolver = await this.resolverFor(name);
    const dns = dnsEncode(name);
    const calls = Object.entries(records).map(([k, v]) => encodeFunctionData({ abi: PermissionedResolverImpl.abi, functionName: "setText", args: [dns, k, v] }));
    try {
      const tx = await this.send(resolver, PermissionedResolverImpl.abi, "multicall", [calls]);
      return { providerId: this.providerId, chain: this.chain, operation: "PUBLISH_RECORDS", name, txs: [tx], status: "CONFIRMED" };
    } catch (err) {
      return { providerId: this.providerId, chain: this.chain, operation: "PUBLISH_RECORDS", name, txs: [], status: "FAILED", detail: (err as Error).message.split("\n")[0] };
    }
  }

  /** Identity/discovery revocation only; it never touches financial authority. */
  async revoke(name: string, mode: "CLEAR_RECORDS" | "UNBIND" | "BURN_SUBNAME"): Promise<IdentityReceipt> {
    try {
      if (mode === "BURN_SUBNAME") {
        const [label, ...rest] = name.split(".");
        const parentLabel = rest.join(".").replace(/\.eth$/, "");
        const userRegistry = (await this.publicClient.readContract({ address: this.d.ethRegistry, abi: ETHRegistry.abi, functionName: "getSubregistry", args: [parentLabel] })) as Address;
        const tx = await this.send(userRegistry, UserRegistryImpl.abi, "unregister", [BigInt(labelhash(label!))]);
        return { providerId: this.providerId, chain: this.chain, operation: "REVOKE", name, txs: [tx], status: "CONFIRMED", detail: "subname unregistered" };
      }
      const cleared = Object.fromEntries(KIDO_RECORD_KEYS.map((k) => [k, ""]));
      const r = await this.publishRecords(name, cleared);
      return { ...r, operation: "REVOKE", detail: "discovery records cleared" };
    } catch (err) {
      return { providerId: this.providerId, chain: this.chain, operation: "REVOKE", name, txs: [], status: "FAILED", detail: (err as Error).message.split("\n")[0] };
    }
  }

  private async resolverFor(name: string): Promise<Address> {
    const known = this.resolvers.get(name);
    if (known) return known;
    const [resolver] = (await this.publicClient.readContract({ address: this.d.universalResolver, abi: UniversalResolverV2.abi, functionName: "findResolver", args: [dnsEncode(name)] })) as [Address, Hex, bigint];
    if (resolver === zeroAddress) throw new Error(`no resolver for ${name}`);
    return resolver;
  }

  private requireWallet(): Wallet {
    if (!this.wallet) throw new Error("ENS adapter is read-only (no wallet)");
    return this.wallet;
  }

  private async send(address: Address, abi: readonly unknown[], functionName: string, args: unknown[]): Promise<Hex> {
    const w = this.requireWallet();
    const { request } = await this.publicClient.simulateContract({ address, abi: abi as never, functionName, args, account: w.account } as never);
    const tx = await w.writeContract(request as never);
    await this.confirm(tx);
    return tx;
  }

  private async confirm(tx: Hex) {
    const r = await this.publicClient.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error(`transaction reverted: ${tx}`);
  }

  private async waitForChainTime(seconds: number) {
    const start = (await this.publicClient.getBlock()).timestamp;
    for (;;) {
      await new Promise((r) => setTimeout(r, 6000));
      if ((await this.publicClient.getBlock()).timestamp >= start + BigInt(seconds)) return;
    }
  }
}
