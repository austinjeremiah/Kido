# Kido environment

Kido reads everything from the environment; see [`.env.example`](.env.example) for the full list of
names. Only names belong in the repository — never values.

| Tier | Needs | Without it |
|---|---|---|
| Unit / mock integration | nothing | runs |
| Live model (design interview, agent chat, live eval) | `OPENAI_API_KEY` (optional `OPENAI_MODEL` / `KIDO_MODEL`) | `BLOCKED_ENV` |
| Sepolia live scripts | `SEPOLIA_RPC_URL`, `FUNDER_PRIVATE_KEY` or `KIDO_OPERATOR_KEY` (gas only), `KIDO_DEMO_KEYS` | `BLOCKED_ENV` |
| Sui live scripts | `KIDO_DEMO_KEYS` (Sui relayer inside), `KIDO_SUI_SIGNER_KEY` for Seal | `BLOCKED_ENV` |
| Cross-chain scripts | the above plus `KIDO_XCHAIN_STATE`, `KIDO_EVM_BALANCE_FLOOR` | `BLOCKED_ENV` |

Keys used by scripts are disposable testnet keys held outside the repository. Owner controller keys
are never given to Kido: the API takes controller, issuer and agent **addresses** only.
