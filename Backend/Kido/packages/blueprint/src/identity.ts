import { hexToBytes, keccak256, toHex } from "viem";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The stable platform identity of an agent (bible §24.1). It depends only on the project and a
 * creation salt, so rotating signers, moving endpoints or rebinding ENS/SuiNS names never changes it.
 */
export function deriveKidoAgentId(projectId: string, salt: string): string {
  const h = hexToBytes(keccak256(toHex(`kido.agent-id/v1|${projectId}|${salt}`)));
  return `kido:agent:${base32(h.slice(0, 10))}`;
}
