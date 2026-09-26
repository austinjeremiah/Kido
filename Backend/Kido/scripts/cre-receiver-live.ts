/**
 * Live CRE receiver check on Sepolia. Deploys KidoCreReceiver pinned to Chainlink's
 * MockKeystoneForwarder (the forwarder `cre workflow simulate --broadcast` uses), delivers a report
 * through that forwarder and reads the forwarder's transmission state and the recorded decision.
 * The report is not DON-signed: this proves the receiver interface and forwarder path, and is
 * labelled SIMULATED_DON, never confidential or DON-verified.
 * Needs SEPOLIA_RPC_URL and FUNDER_PRIVATE_KEY.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { concat, createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ProviderRegistry, rpcUrl } from "@kido/registry";

const pk = process.env.FUNDER_PRIVATE_KEY as Hex | undefined;
if (!pk) {
  console.log(JSON.stringify({ status: "BLOCKED_ENV", reason: "FUNDER_PRIVATE_KEY is not set" }));
  process.exit(2);
}
const cre = new ProviderRegistry().get("chainlink-cre")!;
const forwarder = (cre.deployments["ethereum-sepolia"] as Record<string, Hex>).mockForwarder!;
const account = privateKeyToAccount(pk);
const transport = http(rpcUrl("ethereum-sepolia"));
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });

const artifact = JSON.parse(readFileSync("contracts/out/KidoCreReceiver.sol/KidoCreReceiver.json", "utf8"));
const WF_NAME = toHex("kido-dec01", { size: 10 });
const abi = parseAbi([
  "constructor(address,address,bytes10)",
  "function decisions(bytes32) view returns (bool act, bytes32 blueprintHash, uint64 evaluatedAt, bytes32 workflowCid)",
  "function supportsInterface(bytes4) view returns (bool)",
]);
const fwdAbi = parseAbi([
  "function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)",
  "function getTransmissionInfo(address receiver, bytes32 workflowExecutionId, bytes2 reportId) view returns ((bytes32 transmissionId, uint8 state, address transmitter, bool invalidReceiver, bool success, uint80 gasLimit))",
  "function typeAndVersion() view returns (string)",
]);

// The workflow owner is pinned to the deployer here, standing in for the CRE workflow owner.
const deployTx = await wallet.deployContract({ abi, bytecode: artifact.bytecode.object as Hex, args: [forwarder, account.address, WF_NAME] });
const receipt = await pub.waitForTransactionReceipt({ hash: deployTx });
const receiver = receipt.contractAddress!;

const key = keccak256(toHex(`kido:cre-live:${Date.now()}`));
const blueprintHash = keccak256(toHex("kido-cre-live-blueprint"));
const evaluatedAt = BigInt(Math.floor(Date.now() / 1000));
const report = encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }, { type: "bytes32" }, { type: "uint64" }], [key, true, blueprintHash, evaluatedAt]);
const executionId = keccak256(toHex(`exec:${key}`));
const reportId = "0x0001" as Hex;
const cid = keccak256(toHex("kido-cre-workflow"));
const raw = concat(["0x01", executionId, pad("0x00", { size: 4 }), pad("0x01", { size: 4 }), pad("0x01", { size: 4 }), cid, WF_NAME, account.address, reportId, report]);

const reportTx = await wallet.writeContract({ address: forwarder, abi: fwdAbi, functionName: "report", args: [receiver, raw, "0x", []] });
await pub.waitForTransactionReceipt({ hash: reportTx });
const info = await pub.readContract({ address: forwarder, abi: fwdAbi, functionName: "getTransmissionInfo", args: [receiver, executionId, reportId] });
const [act, bp, at] = await pub.readContract({ address: receiver, abi, functionName: "decisions", args: [key] });
const STATES = ["NOT_ATTEMPTED", "SUCCEEDED", "INVALID_RECEIVER", "FAILED"];

const evidence = {
  at: new Date().toISOString(),
  network: "ethereum-sepolia",
  forwarder,
  forwarderVersion: await pub.readContract({ address: forwarder, abi: fwdAbi, functionName: "typeAndVersion" }),
  receiver,
  deployTx,
  reportTx,
  transmissionState: STATES[info.state] ?? String(info.state),
  decisionRecorded: act === true && bp === blueprintHash && at === evaluatedAt,
  trust: "SIMULATED_DON: MockKeystoneForwarder does not verify DON signatures; not confidential, not DON-verified",
  status: STATES[info.state] === "SUCCEEDED" && act === true ? "RECEIVER_VERIFIED_LIVE" : "FAILED",
};
const dir = process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence/cre";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `receiver-live-${Date.now()}.json`), JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
process.exit(evidence.status === "RECEIVER_VERIFIED_LIVE" ? 0 : 1);
