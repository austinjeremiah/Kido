import { createApi } from "./api.js";
import { createDeployments, createFoundry, loadConfig } from "./config.js";

const config = loadConfig();
const port = Number(process.env.KIDO_API_PORT ?? 4310);
const host = process.env.KIDO_API_HOST ?? "127.0.0.1";
const foundry = createFoundry(config);
const server = createApi(foundry, config, createDeployments(foundry));
server.listen(port, host, () => {
  const a = server.address();
  console.log(JSON.stringify({ listening: typeof a === "object" && a ? `http://${host}:${a.port}` : a, interviewModel: config.model, simulationSigners: config.simulationSigners }));
});
