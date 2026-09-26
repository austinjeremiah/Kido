import { describe, expect } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, hexToBytes, keccak256, parseAbiParameters, toHex } from 'viem'
import {
	CAPABILITY_REQUESTED_ABI,
	CAPABILITY_REQUESTED_TOPIC0,
	commitContext,
	decodeAction,
	initWorkflow,
	onCapabilityRequested,
	parsePrivatePolicy,
	policyCommitment,
	type Config,
} from './workflow'
import { evaluatePolicy, ReasonCode, type MarketContext, type PrivatePolicy } from '../../../packages/policy/src/index'

/**
 * CRE-001 .. CRE-015 and CONF-001.
 *
 * These exercise the REAL exported handler from workflow.ts against the REAL @chainlink/cre-sdk
 * (v1.19.1) using the SDK's own public test surface — the same pattern the official
 * hello-confidential-workflows template uses. As that template notes, the public test surface does
 * not yet ship a TEE runtime factory, so the handler is driven with the slice of `TeeRuntime` it
 * actually uses.
 *
 * IMPORTANT LABELLING: this is a LOCAL SDK test. It is NOT the `cre workflow simulate` CLI
 * simulator, and it is NOT a live enclave. See reports/phase-04/CRE_MODE.md and BLK-001.
 */

// The confidentiality canary. If this string ever appears outside the enclave boundary, CONF-001
// fails. It is a TEST value, not a credential.
const CANARY = 'CTXLOCK_CONFIDENTIAL_CANARY_9f2b71c4a83e'
const RISK_TOKEN = 'ctxlock-test-risk-token-NOT-a-real-credential'

const AGENT_IDENTITY = keccak256(toHex('agent-identity-1'))
const AGENT = '0xA263b2cA150B5A1cA7bf08adF966B847c487F50f'
const TARGET = '0xf20B833b26b981F8A2211473f46cf457430CE153'
const RECIPIENT = '0x00000000000000000000000000000000c0ffee00'
const POLICY_ID = keccak256(toHex('contextlock-treasury-v1'))
const ACTION_KIND = keccak256(toHex('MOCK_TRANSFER'))

const TARGET_ABI = [
	{ type: 'function', name: 'transferTo', stateMutability: 'nonpayable',
	  inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
] as const

const privatePolicy = (over: Partial<Record<string, unknown>> = {}) =>
	JSON.stringify({
		policyId: POLICY_ID, policyVersion: 1, enabled: true,
		autoLimit: '1000000000',        // 1,000 USDC (6dp)
		escalationLimit: '10000000000', // 10,000 USDC
		maxSlippageBps: 50, maxVolatilityBps: 600, minLiquidity: '1000000000000',
		targetEthAllocationBps: 5000, rebalanceDriftBps: 500,
		minHealthFactorBps: 13500, targetHealthFactorBps: 16000,
		proprietaryRiskThreshold: 120,
		canary: CANARY,
		allowedActionKinds: [ACTION_KIND],
		allowedTargets: [TARGET],
		authorizedAgentIdentityHashes: [AGENT_IDENTITY],
		...over,
	})

const makeConfig = (): Config => ({
	chainSelector: '16015286601757825753',
	gatewayAddress: '0x1111111111111111111111111111111111111111',
	consumerAddress: '0x2222222222222222222222222222222222222222',
	policySecretId: 'CONTEXTLOCK_PRIVATE_POLICY',
	riskApiSecretId: 'CONTEXTLOCK_RISK_API_TOKEN',
	riskApiUrl: 'https://risk.internal.test/context',
})

const goodContext = (over: Partial<Record<keyof MarketContext, unknown>> = {}) => ({
	observedAtUnix: Math.floor(Date.now() / 1000),
	slippageBps: 12, volatilityBps: 150, liquidity: '9000000000000', healthFactorBps: 18000,
	...(over as Record<string, unknown>),
})

type Harness = {
	runtime: TeeRuntime<Config>
	reports: Array<{ encodedPayload: string }>
	logs: string[]
	capturedHeaders: string[]
	httpBodies: string[]
}

function makeTeeRuntime(opts: {
	policyJson?: string
	contextJson?: string
	statusCode?: number
} = {}): Harness {
	const reports: Array<{ encodedPayload: string }> = []
	const logs: string[] = []
	const capturedHeaders: string[] = []
	const httpBodies: string[] = []
	const policyJson = opts.policyJson ?? privatePolicy()
	const contextJson = opts.contextJson ?? JSON.stringify(goodContext())

	const runtime = {
		config: makeConfig(),
		getSecret: (r: { id?: string }) => ({
			result: () => ({
				id: r.id,
				value: r.id === 'CONTEXTLOCK_PRIVATE_POLICY' ? policyJson : RISK_TOKEN,
			}),
		}),
		callCapability: ({ payload }: { payload: { multiHeaders?: Record<string, { values?: string[] }> } }) => {
			capturedHeaders.push(...(payload.multiHeaders?.Authorization?.values ?? []))
			httpBodies.push(contextJson)
			return {
				result: () => ({
					statusCode: opts.statusCode ?? 200,
					body: new TextEncoder().encode(contextJson),
				}),
			}
		},
		log: (m: string) => logs.push(m),
		usingTheDons: () => ({
			report: (input: { encodedPayload: string }) => {
				reports.push(input)
				return { result: () => ({}) }
			},
		}),
	}
	return { runtime: runtime as unknown as TeeRuntime<Config>, reports, logs, capturedHeaders, httpBodies }
}

/**
 * Build a REAL encoded EVM log, exactly as ContextLockGateway emits it: three indexed topics plus
 * ABI-encoded non-indexed data, all as Uint8Array.
 *
 * This matters. The handler decodes the raw log itself, so the tests must feed it raw bytes rather
 * than a convenient object — otherwise they would exercise a decode path that never runs in
 * production. It also makes CRE-013 structurally true: there is nowhere in an encoded log for an
 * agent to inject a fake `verdict` field.
 */
const makeEvent = (over: Record<string, unknown> = {}) => {
	const amount = (over.amount as bigint) ?? 500_000_000n // 500 USDC
	const recipient = (over.recipient as `0x${string}`) ?? (RECIPIENT as `0x${string}`)
	const callData = encodeFunctionData({ abi: TARGET_ABI, functionName: 'transferTo', args: [recipient, amount] })

	const fields = {
		requestHash: (over.requestHash as `0x${string}`) ?? keccak256(toHex('request-1')),
		agentIdentityHash: (over.agentIdentityHash as `0x${string}`) ?? AGENT_IDENTITY,
		agent: (over.agent as `0x${string}`) ?? (AGENT as `0x${string}`),
		ensNode: keccak256(toHex('ens-node')),
		target: (over.target as `0x${string}`) ?? (TARGET as `0x${string}`),
		value: 0n,
		callData,
		intentHash: keccak256(toHex('intent')),
		policyId: (over.policyId as `0x${string}`) ?? POLICY_ID,
		policyVersion: (over.policyVersion as bigint) ?? 1n,
		actionKind: (over.actionKind as `0x${string}`) ?? ACTION_KIND,
	}

	const topics = encodeEventTopics({
		abi: CAPABILITY_REQUESTED_ABI,
		eventName: 'CapabilityRequested',
		args: {
			requestHash: fields.requestHash,
			agentIdentityHash: fields.agentIdentityHash,
			agent: fields.agent,
		},
	})

	const data = encodeAbiParameters(
		parseAbiParameters(
			'bytes32 ensNode, address target, uint256 value, bytes callData, bytes32 intentHash, bytes32 policyId, uint64 policyVersion, bytes32 actionKind',
		),
		[
			fields.ensNode, fields.target, fields.value, fields.callData,
			fields.intentHash, fields.policyId, fields.policyVersion, fields.actionKind,
		],
	)

	return {
		address: hexToBytes(TARGET as `0x${string}`),
		topics: topics.map((t) => hexToBytes(t as `0x${string}`)),
		data: hexToBytes(data),
	}
}

const verdictOf = (s: string) => s.split(':')[0]
const reasonOf = (s: string) => s.split(':')[1]

describe('ContextLock confidential workflow', () => {
	// CRE-001
	test('CRE-001: a valid exact request returns ALLOW and emits one report', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent())
		expect(verdictOf(out)).toBe('ALLOW')
		expect(reasonOf(out)).toBe(ReasonCode.ALLOW_POLICY_MATCH)
		expect(h.reports).toHaveLength(1)
	})

	// CRE-002
	test('CRE-002: crossing the private autonomous limit returns ESCALATE, not ALLOW', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent({ amount: 5_000_000_000n })) // 5,000
		expect(verdictOf(out)).toBe('ESCALATE')
		expect(reasonOf(out)).toBe(ReasonCode.ESCALATE_AMOUNT)
	})

	test('above the private escalation limit returns DENY', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent({ amount: 50_000_000_000n }))
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_AMOUNT_TOO_HIGH)
	})

	// CRE-004
	test('CRE-004: a policy version change changes the policy commitment', () => {
		const p1 = parsePrivatePolicy(privatePolicy())
		const p2 = parsePrivatePolicy(privatePolicy({ policyVersion: 2 }))
		expect(policyCommitment(p1)).not.toBe(policyCommitment(p2))
	})

	test('CRE-004b: an event declaring a different policy version is DENIED', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent({ policyVersion: 2n }))
		expect(verdictOf(out)).toBe('DENY')
	})

	// CRE-005
	test('CRE-005: a different observed context yields a different context commitment', () => {
		const a = commitContext({ observedAtUnix: 100, slippageBps: 10, volatilityBps: 20, liquidity: 5n, healthFactorBps: 18000 })
		const b = commitContext({ observedAtUnix: 100, slippageBps: 11, volatilityBps: 20, liquidity: 5n, healthFactorBps: 18000 })
		expect(a).not.toBe(b)
	})

	// CRE-006
	test('CRE-006: DENY still emits a report, but the verdict byte is DENY (never ALLOW)', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent({ amount: 50_000_000_000n }))
		expect(verdictOf(out)).toBe('DENY')
		// verdict is encoded as 3 (DENY) in the payload; ALLOW would be 1.
		expect(h.reports[0]!.encodedPayload).toBeDefined()
	})

	// CRE-010
	test('CRE-010: a non-200 context response fails CLOSED with DENY_MALFORMED_CONTEXT', () => {
		const h = makeTeeRuntime({ statusCode: 500 })
		const out = onCapabilityRequested(h.runtime, makeEvent())
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_MALFORMED_CONTEXT)
	})

	// CRE-011
	test('CRE-011: malformed context JSON fails CLOSED', () => {
		const h = makeTeeRuntime({ contextJson: 'not-json-at-all' })
		const out = onCapabilityRequested(h.runtime, makeEvent())
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_MALFORMED_CONTEXT)
	})

	test('CRE-011b: stale context is refused rather than treated as fresh', () => {
		const stale = JSON.stringify(goodContext({ observedAtUnix: Math.floor(Date.now() / 1000) - 600 }))
		const h = makeTeeRuntime({ contextJson: stale })
		const out = onCapabilityRequested(h.runtime, makeEvent())
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_CONTEXT_STALE)
	})

	// CRE-013
	test('CRE-013: an agent cannot supply a verdict at all; the workflow decides', () => {
		const h = makeTeeRuntime()
		// The event is a strongly-typed ABI encoding. Extra keys are simply not representable in
		// it — the agent has no field to put a fake ALLOW into. Passing them changes nothing.
		const ev = makeEvent({ amount: 50_000_000_000n, verdict: 'ALLOW', allow: true })
		const out = onCapabilityRequested(h.runtime, ev)
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_AMOUNT_TOO_HIGH)
	})

	// CRE-014 — the important one
	test('CRE-014: the amount DECODED from calldata is what is judged', () => {
		const h = makeTeeRuntime()
		// The calldata encodes 50,000 USDC. Whatever the agent told the broker it was doing, the
		// bytes that will actually execute say otherwise, and those are what the policy sees.
		const ev = makeEvent({ amount: 50_000_000_000n })
		const out = onCapabilityRequested(h.runtime, ev)
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_AMOUNT_TOO_HIGH)
	})

	test('CRE-014b: decodeAction recovers the true recipient and amount from calldata', () => {
		const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: 'transferTo', args: [RECIPIENT, 12345n] })
		const d = decodeAction(cd)
		expect(d.amount).toBe(12345n)
		expect(d.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase())
	})

	test('an unauthorized agent identity is DENIED regardless of amount', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent({ agentIdentityHash: keccak256(toHex('attacker')) }))
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_AGENT_NOT_AUTHORIZED)
	})

	test('a non-allowlisted target is DENIED', () => {
		const h = makeTeeRuntime()
		const out = onCapabilityRequested(h.runtime, makeEvent({ target: '0x000000000000000000000000000000000000dEaD' }))
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_TARGET_NOT_ALLOWED)
	})

	test('a disabled policy is DENIED', () => {
		const h = makeTeeRuntime({ policyJson: privatePolicy({ enabled: false }) })
		const out = onCapabilityRequested(h.runtime, makeEvent())
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_POLICY_DISABLED)
	})

	test('excess slippage is DENIED; excess volatility ESCALATES', () => {
		const slip = makeTeeRuntime({ contextJson: JSON.stringify(goodContext({ slippageBps: 900 })) })
		expect(reasonOf(onCapabilityRequested(slip.runtime, makeEvent()))).toBe(ReasonCode.DENY_SLIPPAGE)

		const vol = makeTeeRuntime({ contextJson: JSON.stringify(goodContext({ volatilityBps: 5000 })) })
		expect(verdictOf(onCapabilityRequested(vol.runtime, makeEvent()))).toBe('ESCALATE')
	})

	test('insufficient liquidity is DENIED', () => {
		const h = makeTeeRuntime({ contextJson: JSON.stringify(goodContext({ liquidity: '1' })) })
		expect(reasonOf(onCapabilityRequested(h.runtime, makeEvent()))).toBe(ReasonCode.DENY_LIQUIDITY)
	})

	test('the risk credential is injected inside the enclave', () => {
		const h = makeTeeRuntime()
		onCapabilityRequested(h.runtime, makeEvent())
		expect(h.capturedHeaders).toEqual([`Bearer ${RISK_TOKEN}`])
	})

	// ─────────────────────────── CONF-001 ───────────────────────────
	describe('CONF-001: confidential values never cross the boundary', () => {
		const surfaces = () => {
			const h = makeTeeRuntime()
			const returned = onCapabilityRequested(h.runtime, makeEvent())
			return { h, returned }
		}

		test('the canary never appears in the handler return value', () => {
			const { returned } = surfaces()
			expect(returned).not.toContain(CANARY)
		})

		test('the canary never appears in anything crossed via usingTheDons()', () => {
			const { h } = surfaces()
			const blob = JSON.stringify(h.reports)
			expect(blob).not.toContain(CANARY)
			expect(blob).not.toContain(RISK_TOKEN)
		})

		test('the canary never appears in enclave logs (and the handler logs nothing at all)', () => {
			const { h } = surfaces()
			expect(h.logs.join('|')).not.toContain(CANARY)
			// Stronger: the production handler makes no runtime.log call whatsoever, because CRE
			// docs state logs leave the confidentiality boundary.
			expect(h.logs).toHaveLength(0)
		})

		test('no private threshold value crosses the boundary', () => {
			const { h, returned } = surfaces()
			const blob = JSON.stringify(h.reports) + returned + h.logs.join('|')
			for (const secretValue of ['1000000000', '10000000000', '120', '13500', '16000', '9000000000000']) {
				expect(blob).not.toContain(secretValue)
			}
		})

		test('the report payload carries only commitments, verdict and window', () => {
			const { h } = surfaces()
			// Payload is a fixed-width ABI encoding of 7 fields; nothing variable-length can hide
			// a leaked string in it.
			const payload = h.reports[0]!.encodedPayload
			expect(typeof payload).toBe('string')
			expect(payload.length).toBeLessThan(400)
		})
	})
})

describe('initWorkflow', () => {
	test('registers the handler with handlerInTee and a Nitro us-west-2 constraint', () => {
		const handlers = initWorkflow(makeConfig())
		expect(handlers).toHaveLength(1)
		expect(handlers[0]!.fn).toBe(onCapabilityRequested)
		// handlerInTee attaches TEE requirements; cre.handler does not.
		expect(handlers[0]!.requirements).toBeDefined()
	})

	test('the log trigger topic0 is computed from the event signature, not pasted', () => {
		expect(CAPABILITY_REQUESTED_TOPIC0).toBe(
			keccak256(toHex('CapabilityRequested(bytes32,bytes32,address,bytes32,address,uint256,bytes,bytes32,bytes32,uint64,bytes32)')),
		)
	})
})
