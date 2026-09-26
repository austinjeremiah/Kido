import { cre, hexToBase64, logTriggerConfig, type TeeRuntime } from '@chainlink/cre-sdk'
import {
	bytesToHex,
	decodeEventLog,
	decodeFunctionData,
	encodeAbiParameters,
	keccak256,
	parseAbiParameters,
	toHex,
} from 'viem'
import { z } from 'zod'
import {
	DEFAULT_TTL_SECONDS,
	evaluatePolicy,
	verdictToUint,
	type MarketContext,
	type EvaluationRequest,
	type PrivatePolicy,
} from '../../../packages/policy/src/index'

/**
 * ContextLock Confidential Policy Workflow.
 *
 * Chainlink CRE is load-bearing here, not ornamental: this workflow is the ONLY component allowed
 * to see ContextLock's private risk parameters, and its verdict is what the on-chain executor
 * ultimately requires before any value can move.
 *
 * Confidentiality boundary, stated precisely (per current CRE docs):
 *   - CONFIDENTIAL: Vault DON secrets fetched with `getSecret()`, the request/response payloads of
 *     HTTP calls made from the enclave, and intermediate values computed there.
 *   - NOT CONFIDENTIAL: this source code and the compiled binary. The Workflow DON provides the
 *     binary to the enclave. ContextLock therefore never claims its policy ALGORITHM is secret —
 *     only the policy VALUES are.
 *
 * Only a verdict, a reason code, a coarse risk band and commitments cross back out via
 * `usingTheDons()`. No threshold, no secret, and no raw context ever does.
 */

export const configSchema = z.object({
	/** EVM chain the gateway lives on. */
	chainSelector: z.string(),
	/** ContextLockGateway address emitting CapabilityRequested. */
	gatewayAddress: z.string(),
	/** ContextLockCreConsumer that receives the report. */
	consumerAddress: z.string(),
	/** Vault DON secret id holding the private policy JSON. */
	policySecretId: z.string(),
	/** Vault DON secret id holding the risk-feed credential. */
	riskApiSecretId: z.string(),
	/** Risk/context endpoint called from inside the enclave. */
	riskApiUrl: z.string(),
})
export type Config = z.infer<typeof configSchema>

/** The event ContextLockGateway emits when an agent requests evaluation. */
export const CAPABILITY_REQUESTED_ABI = [
	{
		type: 'event',
		name: 'CapabilityRequested',
		inputs: [
			{ name: 'requestHash', type: 'bytes32', indexed: true },
			{ name: 'agentIdentityHash', type: 'bytes32', indexed: true },
			{ name: 'agent', type: 'address', indexed: true },
			{ name: 'ensNode', type: 'bytes32', indexed: false },
			{ name: 'target', type: 'address', indexed: false },
			{ name: 'value', type: 'uint256', indexed: false },
			{ name: 'callData', type: 'bytes', indexed: false },
			{ name: 'intentHash', type: 'bytes32', indexed: false },
			{ name: 'policyId', type: 'bytes32', indexed: false },
			{ name: 'policyVersion', type: 'uint64', indexed: false },
			{ name: 'actionKind', type: 'bytes32', indexed: false },
		],
	},
] as const

const TARGET_ABI = [
	{
		type: 'function',
		name: 'transferTo',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'recipient', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
		outputs: [],
	},
] as const

/**
 * Independently derive the transaction's real parameters from calldata.
 *
 * This is the CRE-014 control. The agent's declared amount is never trusted — if the agent claims
 * "500" while the calldata encodes 5,000,000, the decoded value wins and the policy rules on what
 * will ACTUALLY execute.
 */
export function decodeAction(callData: `0x${string}`): { selector: string; recipient: string; amount: bigint } {
	const selector = callData.slice(0, 10)
	const { functionName, args } = decodeFunctionData({ abi: TARGET_ABI, data: callData })
	if (functionName !== 'transferTo') throw new Error('unsupported selector')
	return { selector, recipient: (args as readonly [string, bigint])[0], amount: (args as readonly [string, bigint])[1] }
}

/** Parse the private policy released into the enclave. */
export function parsePrivatePolicy(raw: string): PrivatePolicy {
	const p = JSON.parse(raw) as Record<string, unknown>
	return {
		policyId: String(p.policyId),
		policyVersion: Number(p.policyVersion),
		enabled: Boolean(p.enabled),
		autoLimit: BigInt(String(p.autoLimit)),
		escalationLimit: BigInt(String(p.escalationLimit)),
		maxSlippageBps: Number(p.maxSlippageBps),
		maxVolatilityBps: Number(p.maxVolatilityBps),
		minLiquidity: BigInt(String(p.minLiquidity)),
		targetEthAllocationBps: Number(p.targetEthAllocationBps),
		rebalanceDriftBps: Number(p.rebalanceDriftBps),
		minHealthFactorBps: Number(p.minHealthFactorBps),
		targetHealthFactorBps: Number(p.targetHealthFactorBps),
		proprietaryRiskThreshold: Number(p.proprietaryRiskThreshold),
		canary: String(p.canary),
		allowedActionKinds: p.allowedActionKinds as string[],
		allowedTargets: p.allowedTargets as string[],
		authorizedAgentIdentityHashes: p.authorizedAgentIdentityHashes as string[],
	}
}

/** Context commitment: proves WHAT was observed without revealing it. */
export function commitContext(ctx: MarketContext): `0x${string}` {
	return keccak256(
		toHex(
			`ctx:${ctx.observedAtUnix}:${ctx.slippageBps}:${ctx.volatilityBps}:${ctx.liquidity}:${ctx.healthFactorBps}`,
		),
	)
}

/**
 * The EVM log trigger delivers a raw protobuf `Log`: `address`, `topics` and `data` as
 * `Uint8Array`, NOT a decoded struct. Decode it here with the event ABI.
 *
 * Doing the decode ourselves is not incidental — it means the handler reads the same bytes the
 * chain recorded, rather than trusting any off-chain summary of them.
 */
export type RawEvmLog = { address: Uint8Array; topics: Uint8Array[]; data: Uint8Array }

export function decodeCapabilityRequested(log: RawEvmLog) {
	const { args } = decodeEventLog({
		abi: CAPABILITY_REQUESTED_ABI,
		eventName: 'CapabilityRequested',
		topics: log.topics.map((t) => bytesToHex(t)) as [`0x${string}`, ...`0x${string}`[]],
		data: bytesToHex(log.data),
	})
	return args as unknown as {
		requestHash: `0x${string}`
		agentIdentityHash: `0x${string}`
		agent: `0x${string}`
		ensNode: `0x${string}`
		target: `0x${string}`
		value: bigint
		callData: `0x${string}`
		intentHash: `0x${string}`
		policyId: `0x${string}`
		policyVersion: bigint
		actionKind: `0x${string}`
	}
}

/**
 * The TEE handler. Receives a `TeeRuntime`, not a `Runtime`: everything here runs inside the
 * attested enclave until `usingTheDons()` is called explicitly.
 */
export const onCapabilityRequested = (runtime: TeeRuntime<Config>, logEvent: unknown): string => {
	const config = runtime.config

	// ── Step 1: private policy, released by the Vault DON into the attested enclave ──
	const policyRaw = runtime.getSecret({ id: config.policySecretId }).result().value
	const policy = parsePrivatePolicy(policyRaw)

	// ── Step 2: the request, decoded from the raw on-chain log ──
	const raw = logEvent as RawEvmLog
	const ev = decodeCapabilityRequested(raw)

	// Derive the real action from calldata rather than trusting declared values.
	const decoded = decodeAction(ev.callData)

	const req: EvaluationRequest = {
		requestHash: ev.requestHash,
		agentIdentityHash: ev.agentIdentityHash,
		ensNode: ev.ensNode,
		agent: ev.agent,
		chainId: 11155111,
		target: ev.target,
		value: ev.value,
		calldataHash: keccak256(ev.callData),
		selector: decoded.selector,
		decodedRecipient: decoded.recipient,
		decodedAmount: decoded.amount,
		intentHash: ev.intentHash,
		policyId: ev.policyId,
		policyVersion: Number(ev.policyVersion),
		actionKind: ev.actionKind,
	}

	// ── Step 3: live context, fetched FROM INSIDE the enclave ──
	// The request and response payloads of this call stay confidential from node operators.
	const riskToken = runtime.getSecret({ id: config.riskApiSecretId }).result().value
	const ctx = fetchContext(runtime, config.riskApiUrl, riskToken)

	// ── Step 4: deterministic decision over confidential data ──
	const nowUnix = Math.floor(Date.now() / 1000)
	const decision = evaluatePolicy(req, policy, ctx, nowUnix)

	// NOTE: deliberately NO runtime.log() of any policy value, secret, threshold or raw context.
	// Current CRE docs are explicit that logs leave the confidentiality boundary. The canary in
	// `policy.canary` exists so CONF-001 can prove nothing confidential escaped.

	// ── Step 5: cross back to the DON with the MINIMUM ──
	// Everything passed into a capability call on `donRuntime` executes on Workflow DON nodes and
	// is no longer confidential. So only: requestHash, verdict, reason, band, commitment, window.
	const donRuntime = runtime.usingTheDons()

	const contextCommitment = commitContext(ctx)
	const validUntil = BigInt(nowUnix + (decision.ttlSeconds || DEFAULT_TTL_SECONDS))

	const encodedPayload = encodeAbiParameters(
		parseAbiParameters(
			'bytes32 requestHash, bytes32 policyCommitment, bytes32 contextCommitment, uint8 verdict, bytes32 reasonCode, uint64 evaluatedAt, uint64 validUntil',
		),
		[
			req.requestHash as `0x${string}`,
			policyCommitment(policy),
			contextCommitment,
			verdictToUint(decision.verdict),
			keccak256(toHex(decision.reasonCode)),
			BigInt(nowUnix),
			validUntil,
		],
	)

	donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	return `${decision.verdict}:${decision.reasonCode}:${decision.riskBand}`
}

/**
 * Commit to the policy identity+version WITHOUT revealing its values.
 * Changing any private threshold changes this commitment, so an authorization issued under one
 * policy version cannot silently apply to another (CRE-004).
 */
export function policyCommitment(p: PrivatePolicy): `0x${string}` {
	return keccak256(
		toHex(
			[
				p.policyId, p.policyVersion, p.enabled,
				p.autoLimit, p.escalationLimit, p.maxSlippageBps, p.maxVolatilityBps,
				p.minLiquidity, p.targetEthAllocationBps, p.rebalanceDriftBps,
				p.minHealthFactorBps, p.targetHealthFactorBps, p.proprietaryRiskThreshold,
			].join('|'),
		),
	)
}

/** Fetch live context from inside the enclave. Malformed responses fail closed. */
function fetchContext(runtime: TeeRuntime<Config>, url: string, token: string): MarketContext {
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url,
			method: 'GET',
			multiHeaders: { Authorization: { values: [`Bearer ${token}`] } },
		})
		.result()

	// A failed or unparseable context must NOT be treated as benign. Returning a deliberately
	// invalid context makes evaluatePolicy fail closed with DENY_MALFORMED_CONTEXT.
	const invalid: MarketContext = {
		observedAtUnix: 0, slippageBps: -1, volatilityBps: -1, liquidity: -1n, healthFactorBps: -1,
	}
	if (!response || (response as { statusCode?: number }).statusCode !== 200) return invalid

	try {
		const bodyBytes = (response as { body?: Uint8Array }).body
		const raw = bodyBytes ? new TextDecoder().decode(bodyBytes) : '{}'
		const j = JSON.parse(raw) as Record<string, unknown>
		return {
			observedAtUnix: Number(j.observedAtUnix),
			slippageBps: Number(j.slippageBps),
			volatilityBps: Number(j.volatilityBps),
			liquidity: BigInt(String(j.liquidity ?? '0')),
			healthFactorBps: Number(j.healthFactorBps),
		}
	} catch {
		return invalid
	}
}

/** topic0 of CapabilityRequested, computed rather than pasted. */
export const CAPABILITY_REQUESTED_TOPIC0 = keccak256(
	toHex(
		'CapabilityRequested(bytes32,bytes32,address,bytes32,address,uint256,bytes,bytes32,bytes32,uint64,bytes32)',
	),
)

/** Register the confidential handler on an EVM log trigger. */
export function initWorkflow(config: Config) {
	// EVMClient takes the chain selector as a bigint in SDK 1.19.1.
	const evm = new cre.capabilities.EVMClient(BigInt(config.chainSelector))

	return [
		// `cre.handlerInTee` (not `cre.handler`) with an explicit Nitro constraint.
		// AWS Nitro in us-west-2 is currently the only registered TEE type and region.
		cre.handlerInTee(
			evm.logTrigger(
				logTriggerConfig({
					addresses: [config.gatewayAddress as `0x${string}`],
					topics: [[CAPABILITY_REQUESTED_TOPIC0]],
				}),
			),
			onCapabilityRequested,
			[{ tee: 'nitro', regions: ['us-west-2'] }],
		),
	]
}
