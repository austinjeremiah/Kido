import type { AssetEntry } from "./types.js";

/** Canonical asset graph entries (bible §15). Tickers are never identity: USDC on Sepolia is three different assets. */
export const ASSETS: AssetEntry[] = [
  { symbol: "USDC", chain: "ethereum-sepolia", ref: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", decimals: 6, testnetOnly: true, economicClass: "USD_STABLE", note: "Aave-listed Sepolia test USDC; the only USDC Aave Sepolia accepts", usableWith: ["aave-v3"], debtTokens: { "aave-v3": "0x36B5dE936eF1710E1d22EabE5231b28581a92ECc" } },
  { symbol: "AMUSD", chain: "ethereum-sepolia", ref: "0x7C4C9876af08676fCE8cfeCF1129Dc2F5D7d0828", decimals: 6, testnetOnly: true, economicClass: "USD_STABLE_DEMO", note: "Amane demo token, openly mintable", usableWith: ["uniswap-v3", "amane"] },
  { symbol: "AMDAI", chain: "ethereum-sepolia", ref: "0xa0b048f06e8c6bbede36011517e9ebb8e142eb09", decimals: 18, testnetOnly: true, economicClass: "USD_STABLE_DEMO", note: "Amane demo token paired with AMUSD in the project Uniswap v3 pool", usableWith: ["uniswap-v3"] },
  { symbol: "AMUSD", chain: "sui-testnet", ref: "0xfbd965e0d52d45341d8bdd525d0fae835a5f9cad11c8194e08f1bd6f3405bee6::amusd::AMUSD", decimals: 6, testnetOnly: true, economicClass: "USD_STABLE_DEMO", note: "Amane demo token; DEMO_EQUIVALENT to Sepolia AMUSD, never NATIVE", usableWith: ["cetus-clmm", "amane"] },
  { symbol: "AMSUI", chain: "sui-testnet", ref: "0xfbd965e0d52d45341d8bdd525d0fae835a5f9cad11c8194e08f1bd6f3405bee6::amsui::AMSUI", decimals: 9, testnetOnly: true, economicClass: "SUI_DEMO", note: "Amane demo token for the project Cetus pool", usableWith: ["cetus-clmm"] },
];
