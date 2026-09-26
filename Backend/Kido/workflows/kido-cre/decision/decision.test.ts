import { describe, expect, it } from 'bun:test'
import { decodeAbiParameters, parseAbiParameters } from 'viem'
import { decide, encodeDecision, pick } from './decision'

describe('private decision', () => {
	it('acts only when the observation crosses the private threshold', () => {
		expect(decide(1.4, '1.5', 'LT', 1n).act).toBe(true)
		expect(decide(1.6, '1.5', 'LT', 1n).act).toBe(false)
		expect(decide('7', 5, 'GT', 1n).act).toBe(true)
	})

	it('fails closed on anything unreadable', () => {
		for (const [o, t] of [[undefined, 1], [1, undefined], ['abc', 1], [NaN, 1], [true, 1], [1, Infinity]] as const) expect(decide(o, t, 'LT', 1n).act).toBe(false)
	})

	it('reads nested observations and rejects malformed bodies', () => {
		expect(pick('{"position":{"healthFactor":1.2}}', 'position.healthFactor')).toBe(1.2)
		expect(pick('not json', 'a')).toBeUndefined()
		expect(pick('{"a":null}', 'a.b')).toBeUndefined()
	})

	it('encodes exactly the fields KidoCreReceiver decodes, and nothing private', () => {
		const key = `0x${'11'.repeat(32)}` as const
		const bp = `0x${'22'.repeat(32)}` as const
		const hex = encodeDecision(key, bp, { act: true, evaluatedAt: 42n })
		expect((hex.length - 2) / 2).toBe(128)
		expect(decodeAbiParameters(parseAbiParameters('bytes32, bool, bytes32, uint64'), hex)).toEqual([key, true, bp, 42n])
	})
})
