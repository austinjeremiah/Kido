/** Emit gateway events at the ESCALATE and DENY amounts so the CRE simulator has real targets. */
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import {
  pub, wRel, dep, AGENT, GATEWAY, TARGET, ACTION_KIND, RECIPIENT, PRIVATE_POLICY,
  TARGET_ABI, GATEWAY_ABI, assertSepolia,
} from "./lib/harness.js";

const AIH = "0xbec703526654c52dcf7d204bdb6b3abdb006c7049a67df2b81a99b8b78ca28b1" as Hex;
const cases: Array<[string, bigint]> = [["ESCALATE", 5_000_000_000n], ["DENY", 50_000_000_000n]];

async function main() {
  await assertSepolia();
  for (const [label, amt] of cases) {
    const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: [RECIPIENT, amt] });
    const tx = await wRel.writeContract({
      address: GATEWAY, abi: GATEWAY_ABI, functionName: "requestEvaluation",
      args: [AIH, AGENT, dep.ens.node as Hex, TARGET, 0n, cd,
             keccak256(toHex(`sim-${label}-${Date.now()}`)), PRIVATE_POLICY.policyId as Hex, 1n, ACTION_KIND],
    });
    const rc = await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`${label} amount=${amt} tx=${tx} block=${rc.blockNumber}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
