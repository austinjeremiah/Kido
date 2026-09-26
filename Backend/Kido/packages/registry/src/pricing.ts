import type { ChainFamily } from "./chains.js";

type Action = "PAY" | "SWAP" | "REPAY" | "BRIDGE" | "SUPPLY";

/**
 * What running an agent costs on mainnet, per provider and per piece of infrastructure it needs.
 * Prices are published list prices with their source and date; gas units are the gas Amane and
 * Kido's identity adapter actually used on Sepolia (same contracts), priced at the market snapshot.
 * Testnet runs cost nothing real; these figures are what the same agent would cost in production.
 */
export interface PriceSource {
  label: string;
  url: string;
  asOf: string;
}

/** Market prices every gas figure is converted with. */
export const MARKET = {
  asOf: "2026-09-26",
  ethUsd: 2689,
  ethGasGwei: 11.15,
  /** Average Sui transaction fee. */
  suiTxUsd: 0.00048,
  hoursPerMonth: 730,
  sources: [
    { label: "ETH/USD (CoinDesk)", url: "https://www.coindesk.com/price/ethereum", asOf: "2026-09-25" },
    { label: "Ethereum average gas (Etherscan gas tracker)", url: "https://etherscan.io/gastracker", asOf: "2026-09-24" },
    { label: "Sui average transaction fee (Chainspect)", url: "https://chainspect.app/chain/sui", asOf: "2026-09-26" },
  ] satisfies PriceSource[],
};

/** Gas measured on Sepolia for the same contracts (receipts from Kido's live runs). */
export const MEASURED_GAS = {
  source: { label: "Kido live runs on Sepolia (treasury-live, identity-live)", url: ".gauntlet/evidence/treasury-live-*", asOf: "2026-09-27" } satisfies PriceSource,
  evm: {
    /** Amane account: deploy, owner policy install, lease activation (paid once per deployment). */
    accountDeploy: 4_568_648,
    policyInstall: 1_508_135,
    leaseActivate: 758_368,
    leaseRevoke: 37_848,
    action: { PAY: 389_775, SWAP: 315_060, REPAY: 541_210, BRIDGE: 413_841 } as Partial<Record<string, number>>,
    /** A bridged arrival's reserved destination action (the committed swap). */
    reservedAction: 254_938,
    /** ENS (ENSv2): name registration, and one subname with its own resolver and records. */
    ensRegister: 533_460,
    ensSubname: 1_157_788,
  },
};

export type PricingModel = "FREE" | "SUBSCRIPTION" | "USAGE" | "PROVIDER_PRICED";

export interface ProviderPricing {
  id: string;
  name: string;
  model: PricingModel;
  /** One line a person reads on the cost card. */
  summary: string;
  /** Name services: yearly price of one name at the agent's name length (5+ characters). */
  namePerYearUsd?: number;
  /** Hosted compute (an attested enclave host): on-demand price per hour. */
  hostPerHourUsd?: number;
  hostKind?: string;
  /** Metered queries: free monthly allowance, then a price per block of queries. */
  freeUnitsPerMonth?: number;
  unitBlock?: number;
  usdPerBlock?: number;
  /** Model tokens: price per million tokens. */
  usdPerMInput?: number;
  usdPerMOutput?: number;
  /** Protocol fee taken from swapped volume (not a bill; it is priced into the trade). */
  volumeFeeBps?: number;
  /** Chain family its transactions are paid on. */
  family?: ChainFamily;
  sources: PriceSource[];
}

export const PRICING: Record<string, ProviderPricing> = {
  ens: {
    id: "ens",
    name: "ENS",
    model: "SUBSCRIPTION",
    summary: "$5 a year for a 5+ character .eth name; subnames are free apart from gas",
    namePerYearUsd: 5,
    family: "evm",
    sources: [{ label: "ENS pricing", url: "https://support.ens.domains/en/articles/12238910-ens-pricing-how-much-do-names-cost", asOf: "2026-09-26" }],
  },
  suins: {
    id: "suins",
    name: "SuiNS",
    model: "SUBSCRIPTION",
    summary: "20 USDC a year for a 5+ character .sui name; subnames only cost Sui gas",
    namePerYearUsd: 20,
    family: "sui",
    sources: [{ label: "SuiNS pricing (SDK docs)", url: "https://docs.suins.io/developer/sdk/querying", asOf: "2026-09-26" }],
  },
  nautilus: {
    id: "nautilus",
    name: "Nautilus",
    model: "SUBSCRIPTION",
    summary: "Nautilus is free; the attested enclave runs on an AWS Nitro host billed by the hour",
    hostPerHourUsd: 0.153,
    hostKind: "AWS c6a.xlarge with Nitro Enclaves (4 vCPU, 8 GiB, us-east-1 on-demand)",
    sources: [
      { label: "AWS c6a.xlarge on-demand", url: "https://aws-pricing.com/c6a.xlarge.html", asOf: "2026-09-26" },
      { label: "Nitro Enclaves: no charge beyond EC2", url: "https://aws.amazon.com/ec2/nitro/nitro-enclaves/faqs/", asOf: "2026-09-26" },
    ],
  },
  "the-graph": {
    id: "the-graph",
    name: "The Graph",
    model: "USAGE",
    summary: "100,000 free queries a month, then $2 per 100,000",
    freeUnitsPerMonth: 100_000,
    unitBlock: 100_000,
    usdPerBlock: 2,
    sources: [{ label: "Subgraph Studio pricing", url: "https://thegraph.com/studio-pricing/", asOf: "2026-09-26" }],
  },
  "openai-model": {
    id: "openai-model",
    name: "Reasoning model (OpenAI GPT-5.6 Luna)",
    model: "USAGE",
    summary: "$1 per million input tokens, $6 per million output tokens",
    usdPerMInput: 1,
    usdPerMOutput: 6,
    sources: [{ label: "OpenAI API pricing", url: "https://developers.openai.com/api/docs/pricing", asOf: "2026-09-26" }],
  },
  "alchemy-rpc": {
    id: "alchemy-rpc",
    name: "RPC (Alchemy)",
    model: "USAGE",
    summary: "30M compute units a month free; $0.525 per million after",
    freeUnitsPerMonth: 30_000_000,
    unitBlock: 1_000_000,
    usdPerBlock: 0.525,
    sources: [{ label: "Alchemy pricing", url: "https://www.alchemy.com/pricing", asOf: "2026-09-26" }],
  },
  "uniswap-v3": { id: "uniswap-v3", name: "Uniswap v3", model: "FREE", summary: "No subscription. The pool's 0.3% fee is priced into each swap; you pay gas", volumeFeeBps: 30, family: "evm", sources: [{ label: "Uniswap v3 fee tiers", url: "https://docs.uniswap.org/concepts/protocol/fees", asOf: "2026-09-26" }] },
  "cetus-clmm": { id: "cetus-clmm", name: "Cetus", model: "FREE", summary: "No subscription. The pool fee is priced into each swap; Sui gas is fractions of a cent", family: "sui", sources: [{ label: "Cetus docs", url: "https://cetus-1.gitbook.io/cetus-docs", asOf: "2026-09-26" }] },
  "aave-v3": { id: "aave-v3", name: "Aave v3", model: "FREE", summary: "Repaying debt is free; you pay gas", family: "evm", sources: [{ label: "Aave docs", url: "https://aave.com/docs", asOf: "2026-09-26" }] },
  amane: { id: "amane", name: "Amane", model: "FREE", summary: "Open contracts, no fees; you pay gas to deploy, renew the lease and act", sources: [MEASURED_GAS.source] },
  wormhole: { id: "wormhole", name: "Wormhole", model: "FREE", summary: "No Token Bridge fee; you pay source gas and the destination redeem (or ~$0.30 for a relayer)", sources: [{ label: "Wormhole bridge fees", url: "https://bridgefees.com/blog/wormhole-bridge-fees-guide", asOf: "2026-09-26" }] },
  "kido-secret-store": { id: "kido-secret-store", name: "Kido secret store", model: "FREE", summary: "Included with Kido", sources: [] },
  seal: { id: "seal", name: "Seal", model: "PROVIDER_PRICED", summary: "Key server providers set their own prices; testnet key servers are free", family: "sui", sources: [{ label: "Seal pricing", url: "https://docs.sui.io/sui-stack/seal/pricing", asOf: "2026-09-26" }] },
  "chainlink-cre": { id: "chainlink-cre", name: "Chainlink CRE", model: "PROVIDER_PRICED", summary: "Mainnet pricing is by arrangement with Chainlink; not published", family: "evm", sources: [{ label: "Chainlink CRE", url: "https://docs.chain.link/cre", asOf: "2026-09-26" }] },
};

/** USD for `gas` units on Ethereum at the market snapshot. */
export const evmGasUsd = (gas: number) => (gas * MARKET.ethGasGwei * 1e-9) * MARKET.ethUsd;
