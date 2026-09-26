import { CHAINS, ProviderRegistry, type ChainProfile } from "@kido/registry";

/**
 * The provider registry and chain profiles the interview reads every provider, asset and chain
 * fact from. Nothing in the interview names a protocol, token or chain by itself.
 */
let current: { registry: ProviderRegistry; chains: ChainProfile[] } = { registry: new ProviderRegistry(), chains: CHAINS };

export function useInterviewRegistry(registry: ProviderRegistry, chains: ChainProfile[] = CHAINS) {
  current = { registry, chains };
}

export const interviewRegistry = () => current.registry;
export const interviewChains = () => current.chains;
