import { cre, hexToBase64, type Runtime, type TeeRuntime } from '@chainlink/cre-sdk'
import { z } from 'zod'
import { decide, encodeDecision, pick } from './decision'

/**
 * Kido private-decision workflow (CRE). Inside the enclave it reads a private threshold and a
 * private API credential from Vault DON secrets, fetches the private observation, and compares
 * them. Only the boolean decision, bound to the Kido blueprint hash, leaves the enclave; it is
 * delivered on-chain to KidoCreReceiver through the KeystoneForwarder.
 */
export const configSchema = z.object({
	schedule: z.string(),
	chainSelector: z.string().regex(/^\d+$/),
	receiverAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	decisionKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
	blueprintHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
	thresholdSecretId: z.string(),
	apiSecretId: z.string(),
	apiUrl: z.string().url(),
	observationPath: z.string(),
	op: z.enum(['LT', 'GT']),
	gasLimit: z.string().regex(/^\d+$/),
})
export type Config = z.infer<typeof configSchema>

export function onSchedule(runtime: TeeRuntime<Config>): string {
	const config = runtime.config
	const threshold = runtime.getSecret({ id: config.thresholdSecretId }).result().value
	const token = runtime.getSecret({ id: config.apiSecretId }).result().value
	const res = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, { url: config.apiUrl, method: 'GET', multiHeaders: { Authorization: { values: [`Bearer ${token}`] } } })
		.result() as { statusCode?: number; body?: Uint8Array }
	const body = res?.statusCode === 200 && res.body ? new TextDecoder().decode(res.body) : ''
	// DON time, never Date.now(): nodes must agree on it.
	const now = BigInt(Math.floor(runtime.now().getTime() / 1000))
	const decision = decide(pick(body, config.observationPath), threshold, config.op, now)

	const don: Runtime<Config> = runtime.usingTheDons()
	const report = don
		.report({ encodedPayload: hexToBase64(encodeDecision(config.decisionKey as `0x${string}`, config.blueprintHash as `0x${string}`, decision)), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' })
		.result()
	new cre.capabilities.EVMClient(BigInt(config.chainSelector))
		.writeReport(don, { receiver: config.receiverAddress, report, gasConfig: { gasLimit: config.gasLimit } })
		.result()
	return decision.act ? 'ACT' : 'NO_ACTION'
}

export function initWorkflow(config: Config) {
	return [cre.handlerInTee(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onSchedule, [{ tee: 'nitro', regions: ['us-west-2'] }])]
}
