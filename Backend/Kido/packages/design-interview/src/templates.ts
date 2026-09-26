/**
 * Interview templates: a known agent shape whose answers the user accepts by choosing it, so the
 * interview asks only what is personal to them (who to pay, whose loan, how much). Every preset is
 * an answer in plain words, read by the same deterministic parsers as a typed answer, so a template
 * can never set a value the interview could not. The owner reviews every value before anything is
 * built, and can edit any of them.
 */
export interface TemplateAsk {
  key: string;
  /** Replaces the catalog wording for this template. */
  text: string;
  /** One answer that fills several requirements: amounts in order (e.g. "100 per hour, 1000 total"). */
  amounts?: string[];
}

export interface InterviewTemplate {
  id: string;
  name: string;
  description: string;
  objective: string;
  /** Answers in the user's words, applied in catalog order. */
  presets: Record<string, string>;
  /** The only questions asked, in order. */
  asks: TemplateAsk[];
  /** What the template brings, for the picker. */
  highlights: string[];
}

export const INTERVIEW_TEMPLATES: InterviewTemplate[] = [
  {
    id: "tpl_crosschain_treasury",
    name: "Cross-chain treasury operator",
    description: "Five specialists on Ethereum and Sui: protects an Aave loan, pays suppliers on both chains, swaps on Uniswap and Cetus, bridges over Wormhole, and recovers partial runs. Public ENS and SuiNS names, a private repay threshold.",
    objective:
      "Build a cross-chain treasury operator on Ethereum Sepolia and Sui testnet. It protects my Aave v3 position by repaying debt automatically when the health factor drops below a private threshold, pays my approved suppliers on both chains, swaps stablecoins on Uniswap v3 and Cetus without accepting a bad price, bridges funds between Ethereum and Sui over Wormhole when one side runs short, and wakes a recovery agent if a step only partially executes. It has a public ENS and SuiNS identity and never borrows, withdraws, or pays anyone I have not approved.",
    presets: {
      chains: "Ethereum Sepolia and Sui testnet",
      protocols: "Aave, Uniswap and Cetus",
      "authority.mode": "Act on its own, within limits I set",
      "authority.withdraw": "no",
      "authority.bridge": "yes, it may bridge between Ethereum and Sui",
      "actions.allowed": "repay my debt, swap tokens, pay approved recipients and move funds across chains",
      "authority.arbitrary_recipients": "only recipients I approve in advance",
      "authority.autonomy": "automatically",
      "assets.spend": "USDC, AMUSD, wAMUSD and AMDAI",
      "limits.swap_floor": "at least 0.95 USDC for each wAMUSD, at least 0.95 AMDAI for each AMUSD, and at least 0.9 AMSUI for each AMUSD",
      "identity.public": "yes",
      "privacy.required": "yes",
      "privacy.values": "a risk threshold: the Aave health factor at which it repays",
      "privacy.hidden_from": "the public chain, other users and the AI agent itself",
      "privacy.plaintext": "only Kido's secret store",
      "privacy.disclosure": "only the decision",
      "monitor.condition": "repay when the Aave health factor drops below my private threshold",
      "recovery.partial": "recover within my limits",
    },
    asks: [
      { key: "payees", text: "Who should it pay? Give each supplier a name and its address, and say which chain (Ethereum Sepolia or Sui testnet)." },
      { key: "beneficiary", text: "Which wallet holds the Aave loan it protects? It will only ever repay that wallet's debt." },
      { key: "limits.window", text: "How much of each token may it spend per hour, and in total before you approve again? (for example: 100 per hour, 1000 total)", amounts: ["limits.window", "limits.total"] },
    ],
    highlights: ["5 agents", "Ethereum + Sui", "Aave · Uniswap · Cetus", "Wormhole bridge", "ENS + SuiNS names", "private repay threshold", "3 questions"],
  },
];

export const templateById = (id: string) => INTERVIEW_TEMPLATES.find((t) => t.id === id);
