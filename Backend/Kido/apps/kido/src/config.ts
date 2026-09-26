import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import { loadAmaneManifest } from "@kido/amane-bridge";
import { OpenAIInterviewModel, RuleBasedInterviewModel, type InterviewModel } from "@kido/design-interview";
import { FileProjectStore, Foundry, WalletDeployments } from "@kido/foundry";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { rpcUrl } from "@kido/registry";

export interface KidoConfig {
  dataDir: string;
  amaneManifestPath: string;
  model: "rule" | "openai";
  /** Public addresses only. Kido never holds a root controller key. */
  signers: { controllers: `0x${string}`[]; issuer: `0x${string}`; agent: `0x${string}` };
  /** True when no signer addresses were configured and throwaway ones are used for compiling and simulation. */
  simulationSigners: boolean;
}

const address = (name: string, v: string): `0x${string}` => {
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return v;
};

/** Everything comes from the environment; missing signer addresses fall back to throwaway simulation-only ones. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): KidoConfig {
  const ctrl = env.KIDO_CONTROLLER_ADDRESSES?.split(",").map((s) => s.trim()).filter(Boolean);
  const configured = Boolean(ctrl?.length && env.KIDO_ISSUER_ADDRESS && env.KIDO_AGENT_ADDRESS);
  const throwaway = () => privateKeyToAccount(generatePrivateKey()).address;
  const model = (env.KIDO_INTERVIEW_MODEL ?? "rule") as KidoConfig["model"];
  if (model !== "rule" && model !== "openai") throw new Error("KIDO_INTERVIEW_MODEL must be rule or openai");
  return {
    dataDir: resolve(env.KIDO_DATA_DIR ?? ".kido/projects"),
    amaneManifestPath: resolve(env.KIDO_AMANE_MANIFEST ?? "../Aname/deployments/testnet.json"),
    model,
    signers: configured
      ? { controllers: ctrl!.map((c, i) => address(`KIDO_CONTROLLER_ADDRESSES[${i}]`, c)), issuer: address("KIDO_ISSUER_ADDRESS", env.KIDO_ISSUER_ADDRESS!), agent: address("KIDO_AGENT_ADDRESS", env.KIDO_AGENT_ADDRESS!) }
      : { controllers: [throwaway()], issuer: throwaway(), agent: throwaway() },
    simulationSigners: !configured,
  };
}

export function interviewModel(c: KidoConfig): InterviewModel {
  return c.model === "openai" ? new OpenAIInterviewModel() : new RuleBasedInterviewModel();
}

export function createFoundry(c: KidoConfig): Foundry {
  return new Foundry({ store: new FileProjectStore(c.dataDir), model: interviewModel(c), amaneManifest: loadAmaneManifest(c.amaneManifestPath), signers: c.signers });
}

/**
 * Wallet-driven deployment. The owner's wallet deploys and signs; Kido needs only its lease issuer
 * key (KIDO_ISSUER_KEY), the agent's address (KIDO_AGENT_ADDRESS) and, for Sui, a gas relayer
 * (KIDO_SUI_RELAYER_KEY). Each missing piece makes the matching step report BLOCKED_ENV.
 */
export function createDeployments(foundry: Foundry, env: NodeJS.ProcessEnv = process.env): WalletDeployments {
  const issuerKey = env.KIDO_ISSUER_KEY as Hex | undefined;
  const agent = env.KIDO_AGENT_ADDRESS && isAddress(env.KIDO_AGENT_ADDRESS) ? env.KIDO_AGENT_ADDRESS : undefined;
  return new WalletDeployments({
    foundry,
    evm: { publicClient: createPublicClient({ chain: sepolia, transport: http(rpcUrl("ethereum-sepolia", env)) }) as never },
    ...(env.KIDO_SUI_RELAYER_KEY ? { sui: { client: new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet", env) }) as never, relayer: Ed25519Keypair.fromSecretKey(env.KIDO_SUI_RELAYER_KEY) as never } } : {}),
    ...(issuerKey ? { issuer: privateKeyToAccount(issuerKey) } : {}),
    ...(agent ? { agent } : {}),
  });
}
