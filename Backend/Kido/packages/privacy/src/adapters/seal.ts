import { SealClient, SessionKey, type KeyServerConfig } from "@mysten/seal";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import type { ProviderRegistry } from "@kido/registry";

export interface SealSettings {
  packageId: string;
  module: string;
  keyServers: KeyServerConfig[];
  threshold: number;
}

/** Seal settings from the registry manifest: key servers, threshold and Kido's reader-policy package. */
export function sealSettings(reg: ProviderRegistry, chain = "sui-testnet"): SealSettings {
  const m = reg.get("seal");
  const dep = m?.deployments[chain as keyof typeof m.deployments] as Record<string, string> | undefined;
  const params = m?.parameters ?? {};
  const names = String(params.keyServers ?? "").split(",").filter(Boolean);
  const packageId = dep?.kidoReaderPolicyPackage;
  if (!m || !dep || !packageId || !names.length) throw new Error(`seal is not configured on ${chain}`);
  const keyServers = names.map((n) => {
    if (!dep[n]) throw new Error(`seal key server ${n} missing from the registry`);
    return { objectId: dep[n]!, weight: 1 };
  });
  return { packageId, module: String(params.policyModule ?? "reader_policy"), keyServers, threshold: Number(params.threshold ?? keyServers.length) };
}

export interface SealedValue {
  policyId: string;
  /** Hex identity: policy id bytes ‖ label bytes. */
  id: string;
  ciphertext: Uint8Array;
}

/**
 * Seal adapter (bible §27): encrypts private values so only readers the on-chain policy lists can
 * obtain decryption keys from the key servers. Kido stores ciphertext only.
 */
export class SealPrivacyAdapter {
  private readonly seal: SealClient;

  constructor(readonly client: SuiGrpcClient, readonly settings: SealSettings) {
    this.seal = new SealClient({ suiClient: client as never, serverConfigs: settings.keyServers, verifyKeyServers: true });
  }

  /** Creates and shares a reader policy owned by `owner`; returns the policy object id. */
  async createPolicy(owner: Signer, readers: string[]): Promise<{ policyId: string; digest: string }> {
    const tx = new Transaction();
    tx.moveCall({ target: `${this.settings.packageId}::${this.settings.module}::create`, arguments: [tx.pure.vector("address", readers)] });
    const res = await this.client.signAndExecuteTransaction({ transaction: tx, signer: owner, include: { effects: true, objectTypes: true } });
    const done = res.Transaction ?? res.FailedTransaction;
    if (!res.Transaction) throw new Error(`policy creation failed: ${done?.digest}`);
    const type = `${this.settings.packageId}::${this.settings.module}::Policy`;
    const created = done!.effects!.changedObjects.find((o) => o.idOperation === "Created" && done!.objectTypes?.[o.objectId] === type);
    if (!created) throw new Error("policy object not found in effects");
    await this.client.waitForTransaction({ digest: done!.digest });
    return { policyId: created.objectId, digest: done!.digest };
  }

  /** Owner-only policy edits; key servers evaluate the current policy on every request. */
  addReader(owner: Signer, policyId: string, reader: string) {
    return this.editReaders(owner, policyId, reader, "add_reader");
  }

  removeReader(owner: Signer, policyId: string, reader: string) {
    return this.editReaders(owner, policyId, reader, "remove_reader");
  }

  private async editReaders(owner: Signer, policyId: string, reader: string, fn: string): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({ target: `${this.settings.packageId}::${this.settings.module}::${fn}`, arguments: [tx.object(policyId), tx.pure.address(reader)] });
    const res = await this.client.signAndExecuteTransaction({ transaction: tx, signer: owner, include: { effects: true } });
    const done = res.Transaction ?? res.FailedTransaction;
    if (!res.Transaction) throw new Error(`${fn} failed: ${done?.digest}`);
    await this.client.waitForTransaction({ digest: done!.digest });
    return done!.digest;
  }

  identity(policyId: string, label: string): string {
    return toHex(new Uint8Array([...fromHex(policyId), ...new TextEncoder().encode(label)]));
  }

  async encrypt(policyId: string, label: string, data: Uint8Array): Promise<SealedValue> {
    const id = this.identity(policyId, label);
    const { encryptedObject } = await this.seal.encrypt({ threshold: this.settings.threshold, packageId: this.settings.packageId, id, data });
    return { policyId, id, ciphertext: encryptedObject };
  }

  /**
   * Decrypts as `reader`; key servers refuse unless the policy lists the reader. SealClient caches
   * derived keys per identity, so every decrypt uses a fresh client: a key fetched for one reader
   * must never serve another.
   */
  async decrypt(value: SealedValue, reader: Signer, ttlMin = 10): Promise<Uint8Array> {
    const seal = new SealClient({ suiClient: this.client as never, serverConfigs: this.settings.keyServers, verifyKeyServers: true });
    const address = reader.toSuiAddress();
    const sessionKey = await SessionKey.create({ address, packageId: this.settings.packageId, ttlMin, signer: reader, suiClient: this.client as never });
    const { signature } = await reader.signPersonalMessage(sessionKey.getPersonalMessage());
    await sessionKey.setPersonalMessageSignature(signature);
    const tx = new Transaction();
    tx.setSender(address);
    tx.moveCall({ target: `${this.settings.packageId}::${this.settings.module}::seal_approve`, arguments: [tx.pure.vector("u8", fromHex(value.id)), tx.object(value.policyId)] });
    const txBytes = await tx.build({ client: this.client, onlyTransactionKind: true });
    return seal.decrypt({ data: value.ciphertext, sessionKey, txBytes });
  }
}
