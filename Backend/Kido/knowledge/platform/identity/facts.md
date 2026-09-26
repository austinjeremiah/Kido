# Kido identity

Every agent has a stable KidoAgentId (kido:agent:...). ENS (Ethereum) and SuiNS (Sui) names are bindings of that id, not the identity itself. Signers, endpoints and name records can rotate without changing the KidoAgentId.

- ENS on Sepolia is ENSv2 beta; text records such as agent-context and agent-endpoint[...] follow draft ENSIP-26.
- SuiNS records are limited to avatar, content_hash and walrus_site_id.
- A public discovery manifest may advertise capabilities; advertised capability is not financial authority.
- Revoking an identity and revoking financial authority are separate operations reported separately.
