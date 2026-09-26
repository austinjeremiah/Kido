/**
 * Live Seal check on Sui testnet: create a reader policy, encrypt a private value, decrypt it as a
 * listed reader, and confirm an unlisted address is refused by the key servers.
 * Needs KIDO_SUI_SIGNER_KEY (a funded testnet suiprivkey). Writes evidence to KIDO_EVIDENCE_DIR.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { ProviderRegistry, rpcUrl } from "@kido/registry";
import { SealPrivacyAdapter, sealSettings } from "@kido/privacy";

const key = process.env.KIDO_SUI_SIGNER_KEY;
if (!key) {
  console.log(JSON.stringify({ status: "BLOCKED_ENV", reason: "KIDO_SUI_SIGNER_KEY is not set" }));
  process.exit(2);
}
const owner = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(key).secretKey);
const stranger = new Ed25519Keypair();
const client = new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") });
const settings = sealSettings(new ProviderRegistry());
const seal = new SealPrivacyAdapter(client, settings);

const secret = new TextEncoder().encode(`kido-private-threshold-${Date.now()}`);
const { policyId, digest } = await seal.createPolicy(owner, [owner.toSuiAddress()]);
const sealed = await seal.encrypt(policyId, "risk-threshold", secret);
const plain = await seal.decrypt(sealed, owner);
const readerOk = Buffer.from(plain).equals(Buffer.from(secret));
let strangerRefused = false;
let strangerError = "";
try {
  await seal.decrypt(sealed, stranger);
} catch (err) {
  strangerRefused = true;
  strangerError = `${(err as Error).name}: ${(err as Error).message}`.slice(0, 300);
}
const evidence = {
  at: new Date().toISOString(),
  network: "sui-testnet",
  packageId: settings.packageId,
  keyServers: settings.keyServers.map((k) => k.objectId),
  threshold: settings.threshold,
  policyId,
  policyTx: digest,
  identity: sealed.id,
  ciphertextBytes: sealed.ciphertext.length,
  readerDecrypts: readerOk,
  strangerRefused,
  strangerError,
  status: readerOk && strangerRefused && /access|NoAccess|denied|not allowed/i.test(strangerError) ? "VERIFIED_LIVE" : "FAILED",
};
const dir = process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence/seal";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `live-${Date.now()}.json`), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.status === "VERIFIED_LIVE" ? 0 : 1);
