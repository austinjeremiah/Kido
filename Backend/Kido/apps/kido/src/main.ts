import { createApi } from "./api.js";
import { createCcipGateway } from "./ccip.js";
import { createDeployments, createEns, createEvidence, createFoundry, loadConfig } from "./config.js";

const config = loadConfig();
const port = Number(process.env.KIDO_API_PORT ?? 4310);
const host = process.env.KIDO_API_HOST ?? "127.0.0.1";
const foundry = createFoundry(config);
const deployments = createDeployments(foundry);
const ccip = createCcipGateway({
  foundry,
  deployments,
  ...(process.env.KIDO_CCIP_SIGNER_KEY ? { signerKey: process.env.KIDO_CCIP_SIGNER_KEY as `0x${string}` } : {}),
  ...(process.env.KIDO_LIVE_RESOLVER ? { resolver: process.env.KIDO_LIVE_RESOLVER as `0x${string}` } : {}),
  evmChainId: Number((foundry.manifest as unknown as { evm: { chainId: number } }).evm.chainId),
});
const server = createApi(foundry, config, deployments, createEvidence(config), createEns(), ccip);
server.listen(port, host, () => {
  const a = server.address();
  console.log(JSON.stringify({ listening: typeof a === "object" && a ? `http://${host}:${a.port}` : a, interviewModel: config.model, simulationSigners: config.simulationSigners }));
});
