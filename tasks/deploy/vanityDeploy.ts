import { DEPLOYABLE_CONTRACTS } from "../../deployment/deployableContracts.js"
import { MiningBudgetExceeded, type VanityPattern, describePattern, expectedAttempts, mineCreate2Salt } from "../utils/create2Mining.js"
import { DeploymentCheckpoint } from "./checkpoint.js"
import { checkpointDeployment, persistSubmittedTransaction } from "./deploymentRecovery.js"
import { logger } from "./logger.js"
import { DEFAULT_CONFIRMATIONS, confirmDeploymentWithReceipt, getDeploymentTransactionJournal, recoverConfirmedDeployment, send } from "./tx.js"
import { MiningLedger, type VanityPlan } from "./vanityPlan.js"

/** A misconfigured factory should fail fast rather than walking the salt space forever. */
const MAX_SALT_COLLISIONS = 20

export interface VanityContext {
	ethers: any
	plan: VanityPlan
	ledger: MiningLedger
}

export function createVanityContext(ethers: any, plan: VanityPlan | null): VanityContext | null {
	if (!plan) return null
	return { ethers, plan, ledger: new MiningLedger(plan.budget) }
}

export interface DeploySpec {
	key: string
	component: string
	label: string
	factory: any
	constructorArgs?: unknown[]
	checkpoint?: DeploymentCheckpoint
}

export interface DeployResult {
	address: string
	gasUsed: bigint
	salt?: string
	factoryAddress?: string
}

/** The create2 record for createDeployedContract, or undefined for an ordinary CREATE. */
export function create2Record(result: DeployResult): { salt: string; factoryAddress: string } | undefined {
	return result.salt ? { salt: result.salt, factoryAddress: result.factoryAddress! } : undefined
}

/**
 * The single deployment seam. Without a declared vanity pattern this is exactly the ordinary
 * CREATE path; with one it mines a CREATE2 salt and deploys through the configured factory.
 */
export async function deployContract(ctx: VanityContext | null, spec: DeploySpec): Promise<DeployResult> {
	const { key, component, label, factory, constructorArgs = [], checkpoint } = spec
	if (DEPLOYABLE_CONTRACTS[key] === undefined) {
		throw new Error(`${label}: ${key} is not registered in deployment/deployableContracts.js; register it before deploying`)
	}

	const pattern = ctx?.plan.patternFor(key)
	if (!ctx || !pattern) {
		const contract = await factory.deploy(...constructorArgs)
		const { address, receipt } = await confirmDeploymentWithReceipt(contract, label, checkpointDeployment(checkpoint, component, constructorArgs))
		return { address, gasUsed: receipt.gasUsed }
	}

	return deployViaCreate2(ctx, { ...spec, constructorArgs }, pattern)
}

async function deployViaCreate2(
	ctx: VanityContext,
	spec: DeploySpec & { constructorArgs: unknown[] },
	pattern: VanityPattern,
): Promise<DeployResult> {
	const { ethers, plan, ledger } = ctx
	const { label, component, checkpoint, factory, constructorArgs } = spec

	const initCode = ethers.concat([factory.bytecode, factory.interface.encodeDeploy(constructorArgs)])
	const initCodeHex = ethers.hexlify(initCode)
	const create2Factory = await ethers.getContractAt("Create2Factory", plan.factoryAddress)
	const expected = expectedAttempts(pattern)

	let startNonce = 0n
	let saltCollisions = 0

	while (true) {
		logger.info(`  Mining CREATE2 salt for ${label} (${describePattern(pattern)})...`)
		let mined
		try {
			mined = mineCreate2Salt(plan.factoryAddress, initCodeHex, pattern, {
				startNonce,
				maxAttempts: ledger.capFor(expected),
				onProgress: attempts =>
					logger.info(`  ${label}: ${attempts.toLocaleString()} attempts (${Math.round((attempts / expected) * 100)}% of expected)`),
			})
		} catch (error) {
			if (error instanceof MiningBudgetExceeded) {
				throw new Error(
					`${label}: vanity mining stopped after ${error.attempts.toLocaleString()} attempts for ${describePattern(pattern)}. ` +
						"Raise create2.miningBudget or loosen the pattern and re-run; the checkpoint resumes from what is already deployed.",
				)
			}
			throw error
		}
		ledger.spend(mined.attempts)
		logger.info(`  Found salt after ${mined.attempts.toLocaleString()} attempts (${(mined.elapsedMs / 1000).toFixed(1)}s) → ${mined.address}`)

		// Skipping an occupied address costs nothing here; discovering it on-chain costs a transaction.
		if ((await ethers.provider.getCode(mined.address)) !== "0x") {
			logger.info(`  ${mined.address} already has code, trying the next match...`)
			startNonce = BigInt(mined.salt) + 1n
			saltCollisions++
			if (saltCollisions > MAX_SALT_COLLISIONS) {
				throw new Error(
					`Aborting CREATE2 mining for ${label} after ${MAX_SALT_COLLISIONS} occupied addresses — check the factory address and pattern.`,
				)
			}
			continue
		}

		const deployment = {
			kind: "create2" as const,
			component,
			expectedAddress: mined.address,
			factoryAddress: plan.factoryAddress,
			salt: mined.salt,
			initCodeHash: ethers.keccak256(initCodeHex),
			factoryCallDataHash: ethers.keccak256(create2Factory.interface.encodeFunctionData("deploy", [mined.salt, initCode])),
			constructorArgs,
		}

		try {
			const receipt = await send(create2Factory.deploy(mined.salt, initCode), `deploy ${label} via CREATE2`, DEFAULT_CONFIRMATIONS, {
				deployment,
				onSubmitted: checkpoint ? record => persistSubmittedTransaction(checkpoint, record) : undefined,
			})
			await recoverConfirmedDeployment(getDeploymentTransactionJournal(), component, ethers.provider)
			return { address: mined.address, gasUsed: receipt.gasUsed, salt: mined.salt, factoryAddress: plan.factoryAddress }
		} catch (err: any) {
			// The address was empty immediately before broadcast. If code appeared while receipt
			// waiting failed, it may be this exact transaction; mining another salt would orphan
			// it. The transaction journal must reconcile it first.
			throw new Error(
				`CREATE2 ${label} broadcast for ${mined.address} did not confirm; refusing to mine or deploy another salt until resume reconciliation proves its outcome. ` +
					(err instanceof Error ? err.message : String(err)),
			)
		}
	}
}
