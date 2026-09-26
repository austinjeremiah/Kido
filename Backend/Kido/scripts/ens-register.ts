/**
 * Register a FRESH, collision-resistant ContextLock test name on ENSv2 Sepolia.
 *
 * Uses the disposable DEPLOYER wallet only. Never touches a personal name.
 * Asserts chainId == 11155111 before broadcasting anything.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, labelhash, namehash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  ENS_V2_SEPOLIA as ENS, ETH_REGISTRAR_ABI, ETH_REGISTRY_ABI, ERC20_ABI,
} from "../packages/ens/src/deployments.js";

const RPC = process.env.SEPOLIA_RPC_URL!;
const PK = process.env.DEPLOYER_PRIVATE_KEY! as Hex;
const LABEL = process.env.ENS_LABEL!;
const DURATION = 31_536_000n; // 1 year, above MIN_REGISTER_DURATION (28d)

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const acct = privateKeyToAccount(PK);
const wallet = createWalletClient({ account: acct, chain: sepolia, transport: http(RPC) });
const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chainId = await pub.getChainId();
  log("=== ENSv2 Sepolia registration ===");
  log("chainId        =", chainId);
  log("expected       = 11155111");
  if (chainId !== 11155111) throw new Error(`ABORT: chainId ${chainId} is not Sepolia`);
  log("network        = Ethereum Sepolia");
  log("signer         =", acct.address);
  log("label          =", LABEL);
  log("registrar      =", ENS.ethRegistrar);
  log("registry       =", ENS.ethRegistry);

  const available = await pub.readContract({ address: ENS.ethRegistrar, abi: ETH_REGISTRAR_ABI, functionName: "isAvailable", args: [LABEL] });
  log("isAvailable    =", available);
  if (!available) throw new Error(`ABORT: label ${LABEL} is already taken`);

  const [base, premium] = await pub.readContract({
    address: ENS.ethRegistrar, abi: ETH_REGISTRAR_ABI, functionName: "getRegisterPrice",
    args: [LABEL, DURATION, ENS.mockUsdc],
  });
  const price = base + premium;
  const dec = await pub.readContract({ address: ENS.mockUsdc, abi: ERC20_ABI, functionName: "decimals" });
  const sym = await pub.readContract({ address: ENS.mockUsdc, abi: ERC20_ABI, functionName: "symbol" });
  log(`price          = ${price} (${Number(price) / 10 ** Number(dec)} ${sym})`);

  // MockUSDC has an unrestricted mint() — documented test-token flow, no human input needed.
  const bal = await pub.readContract({ address: ENS.mockUsdc, abi: ERC20_ABI, functionName: "balanceOf", args: [acct.address] });
  log("balance        =", bal);
  if (bal < price) {
    const mintTx = await wallet.writeContract({ address: ENS.mockUsdc, abi: ERC20_ABI, functionName: "mint", args: [acct.address, price * 10n] });
    await pub.waitForTransactionReceipt({ hash: mintTx });
    log("mint tx        =", mintTx);
  }

  const apprTx = await wallet.writeContract({ address: ENS.mockUsdc, abi: ERC20_ABI, functionName: "approve", args: [ENS.ethRegistrar, price * 10n] });
  await pub.waitForTransactionReceipt({ hash: apprTx });
  log("approve tx     =", apprTx);

  // --- commit / reveal ---
  const secret = keccak256(toHex(`contextlock-secret-${LABEL}-${Date.now()}`));
  const commitment = await pub.readContract({
    address: ENS.ethRegistrar, abi: ETH_REGISTRAR_ABI, functionName: "makeCommitment",
    args: [LABEL, acct.address, secret, "0x0000000000000000000000000000000000000000", ENS.publicResolverV2, DURATION, "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  log("commitment     =", commitment);

  const commitTx = await wallet.writeContract({ address: ENS.ethRegistrar, abi: ETH_REGISTRAR_ABI, functionName: "commit", args: [commitment] });
  const commitRc = await pub.waitForTransactionReceipt({ hash: commitTx });
  log("commit tx      =", commitTx, `(block ${commitRc.blockNumber})`);

  const minAge = await pub.readContract({ address: ENS.ethRegistrar, abi: ETH_REGISTRAR_ABI, functionName: "MIN_COMMITMENT_AGE" });
  log(`waiting MIN_COMMITMENT_AGE = ${minAge}s ...`);
  await sleep(Number(minAge) * 1000 + 15_000);

  const regTx = await wallet.writeContract({
    address: ENS.ethRegistrar, abi: ETH_REGISTRAR_ABI, functionName: "register",
    args: [LABEL, acct.address, secret, "0x0000000000000000000000000000000000000000", ENS.publicResolverV2, DURATION, ENS.mockUsdc, "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  const regRc = await pub.waitForTransactionReceipt({ hash: regTx });
  log("register tx    =", regTx, `(status ${regRc.status}, block ${regRc.blockNumber})`);
  if (regRc.status !== "success") throw new Error("ABORT: registration reverted");

  // --- verify live state ---
  const name = `${LABEL}.eth`;
  const lh = labelhash(LABEL);
  const node = namehash(name);
  const labelId = BigInt(lh);

  const tokenId = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] });
  const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] });
  const expiry = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getExpiry", args: [labelId] });
  const resolver = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getResolver", args: [LABEL] });

  log("\n=== live registered state ===");
  log("name           =", name);
  log("labelhash      =", lh);
  log("namehash/node  =", node);
  log("labelId        =", labelId.toString());
  log("tokenId        =", tokenId.toString());
  log("owner          =", owner);
  log("expiry         =", expiry.toString(), new Date(Number(expiry) * 1000).toISOString());
  log("resolver       =", resolver);

  const out = {
    name, label: LABEL, labelhash: lh, node, labelId: labelId.toString(),
    tokenId: tokenId.toString(), owner, expiry: expiry.toString(), resolver,
    registrar: ENS.ethRegistrar, registry: ENS.ethRegistry, mockUsdc: ENS.mockUsdc,
    priceBaseUnits: price.toString(),
    transactions: { approve: apprTx, commit: commitTx, register: regTx },
    registeredAtBlock: regRc.blockNumber.toString(),
    chainId, timestamp: new Date().toISOString(),
  };
  // Resolve against the repo root, not process.cwd() — the script must work from anywhere.
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "deployments", "ens-sepolia.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  log("\nwrote", outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
