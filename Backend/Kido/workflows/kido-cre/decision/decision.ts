import { encodeAbiParameters, parseAbiParameters, type Hex } from 'viem'

export type Op = 'LT' | 'GT'

/** Only this leaves the confidential computation: act or not, bound to the blueprint revision. */
export interface Decision {
	act: boolean
	evaluatedAt: bigint
}

/**
 * DECISION_ONLY evaluation of a private threshold against a private observation. Anything that
 * cannot be read as a finite number fails closed (no action).
 */
export function decide(observed: unknown, threshold: unknown, op: Op, nowUnix: bigint): Decision {
	const o = typeof observed === 'number' ? observed : Number(observed)
	const t = typeof threshold === 'number' ? threshold : Number(threshold)
	if (typeof observed === 'boolean' || typeof threshold === 'boolean' || !Number.isFinite(o) || !Number.isFinite(t)) return { act: false, evaluatedAt: nowUnix }
	return { act: op === 'LT' ? o < t : o > t, evaluatedAt: nowUnix }
}

/** Reads `path` (dot-separated) from a JSON body; undefined when absent or malformed. */
export function pick(body: string, path: string): unknown {
	try {
		let v: unknown = JSON.parse(body)
		for (const k of path.split('.')) {
			if (v === null || typeof v !== 'object') return undefined
			v = (v as Record<string, unknown>)[k]
		}
		return v
	} catch {
		return undefined
	}
}

/** Payload KidoCreReceiver decodes: (bytes32 key, bool act, bytes32 blueprintHash, uint64 evaluatedAt). */
export function encodeDecision(key: Hex, blueprintHash: Hex, d: Decision): Hex {
	return encodeAbiParameters(parseAbiParameters('bytes32 key, bool act, bytes32 blueprintHash, uint64 evaluatedAt'), [key, d.act, blueprintHash, d.evaluatedAt])
}
