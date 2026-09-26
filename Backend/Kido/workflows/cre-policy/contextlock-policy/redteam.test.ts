import { describe, expect } from 'bun:test'
import { test } from '@chainlink/cre-sdk/test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import {
	encodeAbiParameters, encodeEventTopics, encodeFunctionData, hexToBytes,
	keccak256, parseAbiParameters, toHex,
} from 'viem'
import {
	CAPABILITY_REQUESTED_ABI, CAPABILITY_REQUESTED_TOPIC0,
	decodeCapabilityRequested, onCapabilityRequested, type Config,
} from './workflow'
import { ReasonCode } from '../../../packages/policy/src/index'

/**
 * P8.8 — attacking the CRE event decoder and the confidential policy path.
 *
 * The centrepiece is CRE-RAW-LOG-001/002: a permanent regression for FND-012, where the workflow
 * assumed the trigger delivered a decoded struct and would have failed identically on the live
 * network. Those two tests exist so that bug cannot quietly return.
 */
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

const privatePolicy = () => JSON.stringify({
	policyId: POLICY_ID, policyVersion: 1, enabled: true,
	autoLimit: '1000000000', escalationLimit: '10000000000',
	maxSlippageBps: 50, maxVolatilityBps: 600, minLiquidity: '1000000000000',
	targetEthAllocationBps: 5000, rebalanceDriftBps: 500,
	minHealthFactorBps: 13500, targetHealthFactorBps: 16000, proprietaryRiskThreshold: 120,
	canary: CANARY, allowedActionKinds: [ACTION_KIND], allowedTargets: [TARGET],
	authorizedAgentIdentityHashes: [AGENT_IDENTITY],
})

const config = (): Config => ({
	chainSelector: '16015286601757825753',
	gatewayAddress: '0x1111111111111111111111111111111111111111',
	consumerAddress: '0x2222222222222222222222222222222222222222',
	policySecretId: 'CONTEXTLOCK_PRIVATE_POLICY',
	riskApiSecretId: 'CONTEXTLOCK_RISK_API_TOKEN',
	riskApiUrl: 'https://risk.internal.test/context',
})

const ctx = (over: Record<string, unknown> = {}) => JSON.stringify({
	observedAtUnix: Math.floor(Date.now() / 1000),
	slippageBps: 12, volatilityBps: 150, liquidity: '9000000000000', healthFactorBps: 18000, ...over,
})

function runtime(opts: { contextJson?: string; statusCode?: number } = {}) {
	const reports: unknown[] = []
	const logs: string[] = []
	const rt = {
		config: config(),
		getSecret: (r: { id?: string }) => ({
			result: () => ({ id: r.id, value: r.id === 'CONTEXTLOCK_PRIVATE_POLICY' ? privatePolicy() : RISK_TOKEN }),
		}),
		callCapability: () => ({
			result: () => ({
				statusCode: opts.statusCode ?? 200,
				body: new TextEncoder().encode(opts.contextJson ?? ctx()),
			}),
		}),
		log: (m: string) => logs.push(m),
		usingTheDons: () => ({ report: (i: unknown) => { reports.push(i); return { result: () => ({}) } } }),
	}
	return { runtime: rt as unknown as TeeRuntime<Config>, reports, logs }
}

/** Build a genuinely ABI-encoded log, exactly as the gateway emits and the trigger delivers. */
function realLog(over: Record<string, unknown> = {}) {
	const amount = (over.amount as bigint) ?? 500_000_000n
	const callData = encodeFunctionData({ abi: TARGET_ABI, functionName: 'transferTo', args: [RECIPIENT as `0x${string}`, amount] })
	const topics = encodeEventTopics({
		abi: CAPABILITY_REQUESTED_ABI, eventName: 'CapabilityRequested',
		args: {
			requestHash: (over.requestHash as `0x${string}`) ?? keccak256(toHex('req-1')),
			agentIdentityHash: (over.agentIdentityHash as `0x${string}`) ?? AGENT_IDENTITY,
			agent: AGENT as `0x${string}`,
		},
	})
	const data = encodeAbiParameters(
		parseAbiParameters('bytes32 a, address b, uint256 c, bytes d, bytes32 e, bytes32 f, uint64 g, bytes32 h'),
		[keccak256(toHex('node')), (over.target as `0x${string}`) ?? (TARGET as `0x${string}`), 0n, callData,
		 keccak256(toHex('intent')), POLICY_ID, (over.policyVersion as bigint) ?? 1n, ACTION_KIND],
	)
	return {
		address: hexToBytes(TARGET as `0x${string}`),
		topics: topics.map((t) => hexToBytes(t as `0x${string}`)),
		data: hexToBytes(data),
	}
}

const verdictOf = (s: string) => s.split(':')[0]
const reasonOf = (s: string) => s.split(':')[1]

describe('P8.8 CRE decoder attacks', () => {
	// ─────────────────────── FND-012 permanent regression ───────────────────────

	test('CRE-RAW-LOG-001: a genuinely ABI-encoded log decodes and produces a verdict', () => {
		const h = runtime()
		const out = onCapabilityRequested(h.runtime, realLog())
		expect(verdictOf(out)).toBe('ALLOW')
		// And the decode really did recover the on-chain fields.
		const decoded = decodeCapabilityRequested(realLog())
		expect(decoded.target.toLowerCase()).toBe(TARGET.toLowerCase())
		expect(decoded.policyId).toBe(POLICY_ID)
		expect(decoded.policyVersion).toBe(1n)
	})

	test('CRE-RAW-LOG-002: the OLD fake decoded-struct shape cannot be routed through the handler', () => {
		// This is precisely the representation the workflow used to assume (FND-012). It must not
		// be silently accepted, or the bug returns unnoticed.
		const fakeDecodedStruct = {
			requestHash: keccak256(toHex('req-1')),
			agentIdentityHash: AGENT_IDENTITY,
			agent: AGENT,
			ensNode: keccak256(toHex('node')),
			target: TARGET,
			value: 0n,
			callData: encodeFunctionData({ abi: TARGET_ABI, functionName: 'transferTo', args: [RECIPIENT as `0x${string}`, 500_000_000n] }),
			intentHash: keccak256(toHex('intent')),
			policyId: POLICY_ID,
			policyVersion: 1n,
			actionKind: ACTION_KIND,
		}
		const h = runtime()
		// It has no `topics`/`data`, so decoding throws. It must NOT produce a verdict.
		expect(() => onCapabilityRequested(h.runtime, fakeDecodedStruct as never)).toThrow()
		expect(h.reports.length, 'no report crossed to the DON').toBe(0)
	})

	// ─────────────────────── malformed log attacks ───────────────────────

	test('CRE-DEC-001: wrong event signature (bad topic0) is rejected', () => {
		const log = realLog()
		log.topics[0] = hexToBytes(keccak256(toHex('SomeOtherEvent(uint256)')))
		const h = runtime()
		expect(() => onCapabilityRequested(h.runtime, log)).toThrow()
		expect(h.reports.length).toBe(0)
	})

	test('CRE-DEC-002: missing topics are rejected', () => {
		const log = realLog()
		log.topics = log.topics.slice(0, 2)
		const h = runtime()
		expect(() => onCapabilityRequested(h.runtime, log)).toThrow()
		expect(h.reports.length).toBe(0)
	})

	test('CRE-DEC-003: truncated data is rejected', () => {
		const log = realLog()
		log.data = log.data.slice(0, 64)
		const h = runtime()
		expect(() => onCapabilityRequested(h.runtime, log)).toThrow()
		expect(h.reports.length).toBe(0)
	})

	test('CRE-DEC-004: empty data is rejected', () => {
		const log = realLog()
		log.data = new Uint8Array(0)
		const h = runtime()
		expect(() => onCapabilityRequested(h.runtime, log)).toThrow()
		expect(h.reports.length).toBe(0)
	})

	test('CRE-DEC-005: oversized trailing data does not change the decoded meaning', () => {
		const clean = realLog()
		const padded = realLog()
		padded.data = new Uint8Array([...padded.data, ...new Uint8Array(4096)])
		// viem decodes the declared parameters; trailing junk must not shift any field.
		const a = decodeCapabilityRequested(clean)
		const b = decodeCapabilityRequested(padded)
		expect(b.target).toBe(a.target)
		expect(b.policyId).toBe(a.policyId)
		expect(b.callData).toBe(a.callData)
	})

	test('CRE-DEC-006: an unauthorized agent identity in a well-formed log is DENIED', () => {
		const h = runtime()
		const out = onCapabilityRequested(h.runtime, realLog({ agentIdentityHash: keccak256(toHex('attacker')) }))
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_AGENT_NOT_AUTHORIZED)
	})

	test('CRE-DEC-007: a wrong target in a well-formed log is DENIED', () => {
		const h = runtime()
		const out = onCapabilityRequested(h.runtime, realLog({ target: '0x000000000000000000000000000000000000dEaD' }))
		expect(verdictOf(out)).toBe('DENY')
		expect(reasonOf(out)).toBe(ReasonCode.DENY_TARGET_NOT_ALLOWED)
	})

	test('CRE-DEC-008: an old policy version is DENIED', () => {
		const h = runtime()
		const out = onCapabilityRequested(h.runtime, realLog({ policyVersion: 99n }))
		expect(verdictOf(out)).toBe('DENY')
	})

	test('topic0 is derived from the signature, never pasted', () => {
		expect(CAPABILITY_REQUESTED_TOPIC0).toBe(
			keccak256(toHex('CapabilityRequested(bytes32,bytes32,address,bytes32,address,uint256,bytes,bytes32,bytes32,uint64,bytes32)')),
		)
	})

	// ─────────────────────── duplicate / replay at the event layer ───────────────────────

	test('CRE-EVT-001: the same event processed twice yields the same deterministic verdict', () => {
		// Determinism matters: the enclave result is attested and verified by DON consensus, so a
		// non-deterministic handler would fail consensus rather than merely be untidy.
		const log = realLog()
		const a = onCapabilityRequested(runtime().runtime, log)
		const b = onCapabilityRequested(runtime().runtime, log)
		expect(a).toBe(b)
	})

	test('CRE-EVT-002: replaying an event grants nothing by itself — authority is on-chain', () => {
		// The workflow emits a report; it does not execute anything. Replay protection lives in
		// the executor nonce and the write-once authorization registry, not here.
		const h = runtime()
		onCapabilityRequested(h.runtime, realLog())
		onCapabilityRequested(h.runtime, realLog())
		expect(h.reports.length).toBe(2)
		// Both reports commit to the SAME request hash, so the registry will accept only one.
		expect(JSON.stringify(h.reports[0])).toBe(JSON.stringify(h.reports[1]))
	})

	// ─────────────────────── confidentiality under attack ───────────────────────

	test('CONF-ATK-001: no malformed input path leaks the canary', () => {
		const attacks = [
			() => onCapabilityRequested(runtime().runtime, realLog({ agentIdentityHash: keccak256(toHex('x')) })),
			() => onCapabilityRequested(runtime({ statusCode: 500 }).runtime, realLog()),
			() => onCapabilityRequested(runtime({ contextJson: 'garbage' }).runtime, realLog()),
			() => onCapabilityRequested(runtime({ contextJson: ctx({ observedAtUnix: 1 }) }).runtime, realLog()),
		]
		for (const a of attacks) {
			let out = ''
			try { out = a() } catch (e) { out = String(e) }
			expect(out).not.toContain(CANARY)
			expect(out).not.toContain(RISK_TOKEN)
			expect(out).not.toContain('1000000000')
		}
	})

	test('CONF-ATK-002: the handler still logs nothing at all, on every path', () => {
		for (const opts of [{}, { statusCode: 500 }, { contextJson: 'garbage' }]) {
			const h = runtime(opts)
			try { onCapabilityRequested(h.runtime, realLog()) } catch { /* expected on some paths */ }
			expect(h.logs.length, 'zero runtime.log calls — logs leave the confidentiality boundary').toBe(0)
		}
	})
})
