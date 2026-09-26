import { z } from "zod";
import { executionNetworks, readOnlySources, FORBIDDEN_LABELS, type NetworkRole } from "@contextlock/studio-network";

/**
 * The product mode.
 *
 * There is one, and naming it is the point of §P28.2. A product with a "testnet mode" implies a
 * production mode next to it, dimmed or coming soon; a product that *is* the Testnet Lab has no
 * such neighbour. The union below has one member, and adding a second would be a deliberate act
 * rather than flipping a flag someone left behind.
 */

export const PRODUCT_MODES = ["CONTEXTLOCK_TESTNET_LAB"] as const;
export const ProductModeSchema = z.enum(PRODUCT_MODES);
export type ProductMode = z.infer<typeof ProductModeSchema>;

export const PRODUCT_MODE: ProductMode = "CONTEXTLOCK_TESTNET_LAB";

/**
 * What the mode means, as data rather than prose.
 *
 * Every field is derived from something enforced elsewhere — the network registry, the CRE mode
 * model, the runtime hardening — so this cannot drift into a marketing description of a system that
 * behaves differently. `LAB-050` cross-checks each claim against its enforcing module.
 */
export interface ProductModeDescriptor {
  mode: ProductMode;
  execution: { networks: ReadonlyArray<{ chainId: number; name: string; role: NetworkRole }>; summary: string };
  mainnet: { access: "READ_ONLY"; summary: string };
  cre: { default: "SIMULATED_USER"; summary: string };
  financialPolicy: { owner: "CONTEXTLOCK"; summary: string };
  runtime: { isolation: "CONTAINER"; summary: string };
  monitoring: { owner: "CONTEXTLOCK_CONTROL_PLANE"; summary: string };
  /** The claim the whole product rests on, phrased so it is checkable rather than reassuring. */
  productionChainExecution: "DISABLED";
}

export function productModeDescriptor(): ProductModeDescriptor {
  return {
    mode: PRODUCT_MODE,
    execution: {
      networks: executionNetworks().map((n) => ({ chainId: n.chainId, name: n.name, role: n.role })),
      summary: "Approved testnets and local forks only",
    },
    mainnet: {
      access: "READ_ONLY",
      summary: `Mainnet is a data source: ${readOnlySources().map((n) => n.name).join(", ")}. It is never an execution network.`,
    },
    cre: { default: "SIMULATED_USER", summary: "The official Chainlink CRE CLI simulator, under your own login" },
    financialPolicy: { owner: "CONTEXTLOCK", summary: "Autonomy, escalation and hard caps are enforced by ContextLock, not by the model" },
    runtime: { isolation: "CONTAINER", summary: "The agent runs in an isolated container holding no credentials" },
    monitoring: { owner: "CONTEXTLOCK_CONTROL_PLANE", summary: "Chain, runtime, CRE and adapter state are read fresh rather than cached" },
    productionChainExecution: "DISABLED",
  };
}

/**
 * The headline claim, and why it is phrased this way.
 *
 * §P28.32 asks for `Production-chain execution: DISABLED` rather than `Real capital at risk: $0`,
 * and the reasoning is worth keeping next to the string. The second is a statement about the
 * world — about what tokens are worth, which nobody here controls — and it is false the moment a
 * testnet asset acquires a price. The first is a statement about this system, and it is enforced at
 * ten named fences and a transport allowlist.
 *
 * A claim you can enforce beats a claim that happens to be true.
 */
export const HEADLINE_CLAIM = "PRODUCTION-CHAIN EXECUTION: DISABLED" as const;

/** Claims the product must never make. Enumerated so their absence is testable. */
export const FORBIDDEN_PRODUCT_CLAIMS = [
  ...FORBIDDEN_LABELS,
  "Real capital at risk: $0",
  "No real money",
  "Risk free",
  "Cannot lose money",
  "Production mode",
  "Mainnet mode",
] as const;

export const MODE_REASONS = {
  NO_PRODUCTION_MODE: "NO_PRODUCTION_MODE_EXISTS",
} as const;

export class ProductModeError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ProductModeError";
  }
}

/**
 * Asked for a production mode.
 *
 * Reachable only by passing a string the type does not permit — a config file, a request body, a
 * cast. Checked anyway, because every one of those is a real way a value arrives.
 */
export function assertProductMode(mode: string): ProductMode {
  if (mode === PRODUCT_MODE) return PRODUCT_MODE;
  throw new ProductModeError(
    MODE_REASONS.NO_PRODUCTION_MODE,
    `"${mode}" is not a ContextLock product mode. There is one mode — ${PRODUCT_MODE} — and no production-mainnet mode exists to switch into. Mainnet is readable and is not an execution network.`,
  );
}
