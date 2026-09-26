import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * The exact message a Kido Nautilus enclave signs, matching `kido_nautilus::decision`:
 * BCS(IntentMessage { intent: u8, timestamp_ms: u64, payload: DecisionPayload }) with
 * DecisionPayload { decision_key: vector<u8>, act: bool, blueprint_hash: vector<u8> }.
 * Only the decision leaves the enclave; the private inputs it was computed from never do.
 */
export const DECISION_INTENT = 0;

const DecisionPayload = bcs.struct("DecisionPayload", { decision_key: bcs.vector(bcs.u8()), act: bcs.bool(), blueprint_hash: bcs.vector(bcs.u8()) });
const IntentMessage = bcs.struct("IntentMessage", { intent: bcs.u8(), timestamp_ms: bcs.u64(), payload: DecisionPayload });

export interface SignedDecision {
  decisionKey: Hex;
  act: boolean;
  blueprintHash: Hex;
  timestampMs: bigint;
  /** Raw 32-byte Ed25519 public key of the signing enclave. */
  publicKey: Hex;
  /** Raw 64-byte Ed25519 signature over `decisionMessage(...)`. */
  signature: Hex;
}

export function decisionMessage(d: { decisionKey: Hex; act: boolean; blueprintHash: Hex; timestampMs: bigint }): Uint8Array {
  return IntentMessage.serialize({
    intent: DECISION_INTENT,
    timestamp_ms: d.timestampMs,
    payload: { decision_key: Array.from(hexToBytes(d.decisionKey)), act: d.act, blueprint_hash: Array.from(hexToBytes(d.blueprintHash)) },
  }).toBytes();
}

/**
 * LOCAL tier only: the same signing code the enclave runs, executed in this process with a local
 * Ed25519 key. It proves message format and on-chain verification, not confidentiality: without
 * an attested enclave (PCRs registered on-chain from a Nitro attestation) nothing here is a TEE.
 */
export class LocalEnclaveSigner {
  private constructor(private readonly key: Ed25519Keypair) {}
  static fromSeed(seed: Uint8Array): LocalEnclaveSigner {
    return new LocalEnclaveSigner(Ed25519Keypair.fromSecretKey(seed));
  }
  static generate(): LocalEnclaveSigner {
    return new LocalEnclaveSigner(new Ed25519Keypair());
  }
  get publicKey(): Hex {
    return bytesToHex(this.key.getPublicKey().toRawBytes());
  }
  async sign(d: { decisionKey: Hex; act: boolean; blueprintHash: Hex; timestampMs: bigint }): Promise<SignedDecision> {
    const signature = await this.key.sign(decisionMessage(d));
    return { ...d, publicKey: this.publicKey, signature: bytesToHex(signature) };
  }
}

/** Off-chain mirror of the on-chain signature check (freshness and replay are checked on-chain). */
export async function verifyDecisionSignature(s: SignedDecision): Promise<boolean> {
  return new Ed25519PublicKey(hexToBytes(s.publicKey)).verify(decisionMessage(s), hexToBytes(s.signature));
}
