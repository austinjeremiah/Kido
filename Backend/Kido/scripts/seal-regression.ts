/**
 * Seal security regression (TESTNET tier, Sui testnet). Proves what Seal is used for in Kido:
 * encrypted values whose decryption keys are released only to readers the current on-chain policy
 * lists. Includes a deliberate reproduction of F-0600 (a shared SealClient serving cached keys to
 * another reader) against naive SDK use, and proves the adapter is not affected.
 *
 * Env: KIDO_SUI_SIGNER_KEY (funded testnet key; never printed), KIDO_EVIDENCE_DIR (optional).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SealClient, SessionKey } from "@mysten/seal";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey, type Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex } from "@mysten/sui/utils";
import { ProviderRegistry, rpcUrl } from "@kido/registry";
import { PrivacyGuard, SealPrivacyAdapter, sealSettings, type SealedValue } from "@kido/privacy";
import { buildAgentContext } from "@kido/runtime";
import { emptyBlueprint, nextRevision } from "@kido/blueprint";

const key = process.env.KIDO_SUI_SIGNER_KEY;
if (!key) {
  console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: "KIDO_SUI_SIGNER_KEY" }));
  process.exit(2);
}
// Every line this script prints is kept, so the final check can prove the secret never reached it.
const printed: string[] = [];
const out = (line: string) => (printed.push(line), console.log(line));

const owner = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(key).secretKey);
const readerB = new Ed25519Keypair();
const stranger = new Ed25519Keypair();
const client = new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") });
const settings = sealSettings(new ProviderRegistry());
const seal = new SealPrivacyAdapter(client, settings);
const secretText = `kido-seal-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const secret = new TextEncoder().encode(secretText);
const guard = new PrivacyGuard();
guard.register("seal-regression-secret", secretText);
const results: { case: string; pass: boolean; detail: string }[] = [];

async function expectDecrypt(name: string, v: SealedValue, reader: Signer, shouldSucceed: boolean, adapter = seal) {
  try {
    const plain = await adapter.decrypt(v, reader);
    const ok = Buffer.from(plain).equals(Buffer.from(secret));
    record(name, shouldSucceed && ok, ok ? "decrypted" : "decrypted to wrong bytes");
  } catch (err) {
    record(name, !shouldSucceed, `refused: ${((err as Error).message ?? String(err)).slice(0, 140)}`);
  }
}
function record(name: string, pass: boolean, detail: string) {
  results.push({ case: name, pass, detail: guard.redact(detail) });
  out(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${guard.redact(detail)}`);
}

const { policyId, digest } = await seal.createPolicy(owner, [owner.toSuiAddress(), readerB.toSuiAddress()]);
out(`policy ${policyId} (${digest}); readers: owner, readerB`);
const sealed = await seal.encrypt(policyId, "risk-api-key", secret);

await expectDecrypt("authorized owner decrypts", sealed, owner, true);
await expectDecrypt("authorized readerB decrypts", sealed, readerB, true);
await expectDecrypt("unlisted address refused", sealed, stranger, false);

// F-0600 reproduction against naive SDK use: one SealClient shared across readers.
{
  const shared = new SealClient({ suiClient: client as never, serverConfigs: settings.keyServers, verifyKeyServers: true });
  const naiveDecrypt = async (reader: Signer) => {
    const sk = await SessionKey.create({ address: reader.toSuiAddress(), packageId: settings.packageId, ttlMin: 10, signer: reader, suiClient: client as never });
    await sk.setPersonalMessageSignature((await reader.signPersonalMessage(sk.getPersonalMessage())).signature);
    const tx = new Transaction();
    tx.setSender(reader.toSuiAddress());
    tx.moveCall({ target: `${settings.packageId}::${settings.module}::seal_approve`, arguments: [tx.pure.vector("u8", fromHex(sealed.id)), tx.object(policyId)] });
    return shared.decrypt({ data: sealed.ciphertext, sessionKey: sk, txBytes: await tx.build({ client, onlyTransactionKind: true }) });
  };
  await naiveDecrypt(owner);
  let leaked = false;
  try {
    leaked = Buffer.from(await naiveDecrypt(stranger)).equals(Buffer.from(secret));
  } catch {}
  record("BREAK F-0600: naive shared SealClient leaks cached keys (exploit class exists)", leaked, leaked ? "reproduced: stranger decrypted via warm cache" : "not reproduced");
  await expectDecrypt("adapter after warm activity: unlisted address still refused", sealed, stranger, false);
}

// Policy change: revoke readerB, add stranger. Access follows the current policy.
out(`remove readerB: ${await seal.removeReader(owner, policyId, readerB.toSuiAddress())}`);
await expectDecrypt("revoked reader refused after previously decrypting", sealed, readerB, false);
out(`add stranger: ${await seal.addReader(owner, policyId, stranger.toSuiAddress())}`);
await expectDecrypt("newly added reader decrypts", sealed, stranger, true);

// Wrong identity / wrong policy / tampered ciphertext / wrong configuration.
{
  const other = await seal.createPolicy(owner, [owner.toSuiAddress()]);
  await expectDecrypt("value presented under another policy object refused", { ...sealed, policyId: other.policyId }, owner, false);
  await expectDecrypt("identity outside the policy namespace refused", { ...sealed, id: seal.identity(other.policyId, "risk-api-key") }, owner, false);
  const tampered = new Uint8Array(sealed.ciphertext);
  tampered[tampered.length - 5] = tampered[tampered.length - 5]! ^ 0xff;
  await expectDecrypt("modified ciphertext rejected", { ...sealed, ciphertext: tampered }, owner, false);
  const wrongPkg = new SealPrivacyAdapter(client, { ...settings, packageId: `0x${"0".repeat(63)}2` });
  await expectDecrypt("wrong policy package (config) refused", sealed, owner, false, wrongPkg);
  const tooFew = new SealPrivacyAdapter(client, { ...settings, keyServers: settings.keyServers.slice(0, 1) });
  await expectDecrypt("key-server set below the encryption threshold refused", sealed, owner, false, tooFew);
}

// The secret never reaches logs or an agent's model context.
{
  const base = emptyBlueprint("seal-regression", "s", "watch a private API");
  const bp = nextRevision(base, { chains: ["sui-testnet"], agents: [{ role: "MonitorAgent", owns: [], mayRequest: [], knowledgePacks: [] }], privacy: { required: true, values: [{ id: "risk-api-key", description: "risk API key", kind: "PRIVATE_API_CREDENTIAL", hiddenFrom: ["AI_AGENT", "PUBLIC_CHAIN"], plaintextBoundary: "KIDO_SECRET_STORE", allowedDisclosure: "BOOLEAN_RESULT", failurePolicy: "FAIL_CLOSED" }], providers: [{ providerId: "seal", chain: "sui-testnet", capabilities: ["ENCRYPTED_STATE"], satisfies: ["risk-api-key"] }] } });
  const ctx = buildAgentContext("MonitorAgent", bp, { untrusted: [{ source: "api", text: "status ok" }] }, { contextFor: () => ({ text: "", included: [], missing: [] }) });
  let clean = true;
  try {
    guard.assertCleanObject(ctx, "model context");
  } catch {
    clean = false;
  }
  record("secret absent from the agent's model context", clean, clean ? "clean" : "LEAKED");
  record("secret absent from everything this run printed", !printed.join("\n").includes(secretText), "scanned stdout");
}

const dir = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence/seal");
mkdirSync(dir, { recursive: true });
const file = join(dir, `regression-${Date.now()}.json`);
const body = JSON.stringify({ at: new Date().toISOString(), packageId: settings.packageId, policyId, results }, null, 2);
writeFileSync(file, body);
record("secret absent from the evidence file", !body.includes(secretText), file);
process.exit(results.every((r) => r.pass) ? 0 : 1);
