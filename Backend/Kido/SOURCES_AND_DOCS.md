# Sources and documentation

Provider facts used by Kido live in the registry (`packages/registry/src/providers`) and the
generated knowledge packs (`knowledge/`), each with its sources, retrieval date and verification
status. `npm run kido -- drift` reports any knowledge that disagrees with the registry.

Primary references re-checked for this build:

- Amane — https://github.com/Kaushikh76/Amane
- Aave v3 (Sepolia market, Pool) — https://aave.com/docs/aave-v3/smart-contracts/pool
- Uniswap v3 deployments — https://docs.uniswap.org/contracts/v3/reference/deployments
- Cetus CLMM — https://github.com/CetusProtocol/cetus-contracts
- Wormhole Token Bridge (EVM and Sui) — https://github.com/wormhole-foundation/wormhole
- ENS — https://docs.ens.domains
- SuiNS — https://docs.suins.io
- Seal — https://seal-docs.wal.app
- Nautilus — https://docs.sui.io/concepts/cryptography/nautilus
- Chainlink CRE — https://docs.chain.link/cre
- Sui JSON-RPC retirement — https://docs.sui.io/develop/accessing-data/json-rpc-migration
