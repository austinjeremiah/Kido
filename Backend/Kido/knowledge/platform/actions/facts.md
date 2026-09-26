# Kido semantic actions

Base actions: SWAP, SUPPLY, REPAY, BORROW, WITHDRAW, STAKE, UNSTAKE, ADD_LIQUIDITY, REMOVE_LIQUIDITY, PAY, BRIDGE.
Composite objectives (REBALANCE, PROTECT_POSITION, DEPLOY_IDLE_CAPITAL, MOVE_LIQUIDITY, HEDGE, REFINANCE, RECOVER) are plans built from base actions.

- A plan step names: stepId, chain (ethereum-sepolia | sui-testnet), action, asset symbol, amount (base units), payee label or null, dependsOn, rationale.
- There is no field for a contract address, calldata or signature. Adapters build chain-native transactions from semantic steps.
- BORROW and WITHDRAW are never granted to an agent in this platform version.
- A later step never executes before the step it depends on has settled.
- If no compliant plan exists, answer NO_COMPLIANT_PLAN instead of inventing budget, payees or protocols.
