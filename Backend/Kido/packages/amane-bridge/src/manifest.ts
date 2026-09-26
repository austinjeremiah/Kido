import { resolve } from "node:path";
import { loadManifest, type AmaneDeploymentManifest } from "@amane/sdk";

/** Kido reads Amane deployments from the manifest Amane publishes, never from scattered constants. */
export function loadAmaneManifest(path = process.env.KIDO_AMANE_MANIFEST ?? resolve(process.cwd(), "../Aname/deployments/testnet.json")): AmaneDeploymentManifest {
  return loadManifest(path);
}
