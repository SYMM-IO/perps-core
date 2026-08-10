/**
 * Deploy and wire SymmioLiquidator. The default mode is read-only planning.
 *
 * ADMIN_PUBLIC_KEY=0x... SYMMIO_ADDRESS=0x... \
 *   ./node_modules/.bin/hardhat run scripts/deployLiquidator.ts --network hyperevm
 *
 * Add EXECUTE=true CONFIRM_CHAIN_ID=<connected chain id> to deploy and wire roles. If deployment succeeds but later
 * wiring fails, resume with LIQUIDATOR_ADDRESS=<deployed proxy>.
 */
import { requireExecutionConfirmation } from "../tasks/deploy/executionGuard.js"
import { setHyperEVMBigBlocks } from "../tasks/deploy/hyperevm.js"
import { deploySymmioLiquidator } from "../tasks/deploy/liquidator.js"
import { send } from "../tasks/deploy/tx.js"
import connection, { hre, ethers } from "../test/helpers/hardhat-connection.js"
import { loadAddresses } from "./utils/file.js"

const HYPEREVM_CHAIN_IDS = new Set<bigint>([998n, 999n])

function requiredAddress(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${name} is required and must be a non-zero address`)
	}
	return ethers.getAddress(value)
}

function parseOperators(raw: string | undefined): string[] {
	const operators = (raw ?? "")
		.split(",")
		.map(value => value.trim())
		.filter(Boolean)
		.map(value => {
			if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`Invalid OPERATORS address: ${value}`)
			return ethers.getAddress(value)
		})
	return [...new Set(operators)]
}

async function requireSuccessfulReceipt(tx: any, label: string): Promise<void> {
	await send(Promise.resolve(tx), label)
}

async function main(): Promise<void> {
	const deployedAddresses = loadAddresses()
	const symmioAddress = requiredAddress("SYMMIO_ADDRESS", deployedAddresses.symmioAddress)
	const admin = requiredAddress("ADMIN_PUBLIC_KEY")
	const resumeAddress = process.env.LIQUIDATOR_ADDRESS ? requiredAddress("LIQUIDATOR_ADDRESS") : undefined
	const operators = parseOperators(process.env.OPERATORS)
	const chainId = (await ethers.provider.getNetwork()).chainId
	const execute = requireExecutionConfirmation(chainId)
	if ((await ethers.provider.getCode(symmioAddress)) === "0x") throw new Error(`No Symmio code at ${symmioAddress}`)
	if (resumeAddress && (await ethers.provider.getCode(resumeAddress)) === "0x") throw new Error(`No SymmioLiquidator code at ${resumeAddress}`)

	const isHyperEVM = HYPEREVM_CHAIN_IDS.has(chainId)
	const isSimulatedNetwork = (connection as any).networkConfig?.type === "edr-simulated"
	const isPersistentLocalhost = chainId === 31337n && (connection as any).networkName === "localhost"
	const manageBigBlocks = isHyperEVM && !isSimulatedNetwork
	console.log("SymmioLiquidator deployment plan")
	console.log(`  Chain:       ${chainId}`)
	console.log(`  Runtime:     ${isPersistentLocalhost ? "persistent local node" : isSimulatedNetwork ? "simulated fork" : "live RPC"}`)
	console.log(`  Symmio:      ${symmioAddress}`)
	console.log(`  Admin:       ${admin}`)
	console.log(`  Liquidator:  ${resumeAddress ?? "deploy new proxy"}`)
	console.log(`  Operators:   ${operators.length > 0 ? operators.join(", ") : "none"}`)
	console.log(`  Mode:        ${execute ? "EXECUTE" : "PLAN ONLY"}`)
	if (!execute) {
		console.log(`\nPlan complete. Review it, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}

	const configuredSigners = await ethers.getSigners()
	let signer = configuredSigners[0]
	if (isPersistentLocalhost) {
		const unlocked: string[] = (await ethers.provider.send("eth_accounts", [])).map((value: string) => ethers.getAddress(value))
		if (!unlocked.includes(admin)) throw new Error(`Local liquidator admin ${admin} is not an unlocked account on the persistent Hardhat node`)
		signer = await ethers.getSigner(admin)
		console.log(`Using unlocked local governance admin ${admin} for liquidator and Core role wiring.`)
	}
	if (!signer) throw new Error("No deployment signer configured")
	const signerAddress = ethers.getAddress(await signer.getAddress())
	if (!resumeAddress && operators.length > 0 && signerAddress !== admin) {
		throw new Error(`New liquidator grants DEFAULT_ADMIN_ROLE only to ${admin}; signer ${signerAddress} cannot register OPERATORS`)
	}

	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", symmioAddress)
	const roleEntries = ["LIQUIDATOR_ROLE", "PARTYB_LIQUIDATOR_ROLE"].map(name => [name, ethers.id(name)] as const)
	for (const [roleName, role] of roleEntries) {
		if (!(await coreView.isRoleAdmin(signerAddress, role))) {
			throw new Error(`Signer ${signerAddress} is not a role admin for ${roleName} on ${symmioAddress}`)
		}
	}

	let bigBlocksEnabled = false
	let deploymentError: unknown
	let cleanupError: unknown
	try {
		if (manageBigBlocks) {
			await setHyperEVMBigBlocks(hre, true)
			bigBlocksEnabled = true
		} else if (isHyperEVM) {
			console.log("Simulated HyperEVM fork detected; skipping the real HyperCore big-block API.")
		}

		let liquidatorAddress = resumeAddress
		if (!liquidatorAddress) {
			// This script is the explicit live exception to the local-only low-level task.
			// EXECUTE + CONFIRM_CHAIN_ID were validated above before calling the deploy helper.
			const contract: any = await deploySymmioLiquidator(hre, { symmioAddress, admin, logData: true })
			liquidatorAddress = ethers.getAddress(await contract.getAddress())
			if ((await ethers.provider.getCode(liquidatorAddress)) === "0x") throw new Error(`Deployment produced no code at ${liquidatorAddress}`)
			console.log(`SymmioLiquidator deployed: ${liquidatorAddress}`)
		}

		const liquidator: any = await ethers.getContractAt("SymmioLiquidator", liquidatorAddress, signer)
		if (ethers.getAddress(await liquidator.symmioAddress()) !== symmioAddress) {
			throw new Error(`SymmioLiquidator ${liquidatorAddress} points to a different Symmio core`)
		}
		const operatorRole = await liquidator.OPERATOR_ROLE()
		for (const operator of operators) {
			if (!(await liquidator.hasRole(operatorRole, operator))) {
				await liquidator.grantRole.staticCall(operatorRole, operator)
				await requireSuccessfulReceipt(await liquidator.grantRole(operatorRole, operator), `grant OPERATOR_ROLE to ${operator}`)
			}
			if (!(await liquidator.hasRole(operatorRole, operator))) throw new Error(`OPERATOR_ROLE post-check failed for ${operator}`)
		}

		const coreControl: any = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", symmioAddress, signer)
		for (const [roleName, role] of roleEntries) {
			if (!(await coreView.hasRole(liquidatorAddress, role))) {
				await coreControl.grantRole.staticCall(liquidatorAddress, role)
				await requireSuccessfulReceipt(await coreControl.grantRole(liquidatorAddress, role), `grant ${roleName} to liquidator`)
			}
			if (!(await coreView.hasRole(liquidatorAddress, role))) throw new Error(`${roleName} post-check failed for ${liquidatorAddress}`)
		}

		console.log(`\nDeployment and wiring verified: ${liquidatorAddress}`)
	} catch (error) {
		deploymentError = error
	} finally {
		if (bigBlocksEnabled) {
			try {
				await setHyperEVMBigBlocks(hre, false)
			} catch (error) {
				cleanupError = new Error(
					`Failed to restore HyperEVM fast blocks; run hyperevm:disable-big-blocks immediately. ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	if (deploymentError !== undefined && cleanupError !== undefined) {
		const primaryMessage = deploymentError instanceof Error ? deploymentError.message : String(deploymentError)
		const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
		const combined = new Error(`SymmioLiquidator deployment or wiring failed: ${primaryMessage}; cleanup also failed: ${cleanupMessage}`) as Error & {
			deploymentError?: unknown
			cleanupError?: unknown
		}
		combined.deploymentError = deploymentError
		combined.cleanupError = cleanupError
		throw combined
	}
	if (deploymentError !== undefined) throw deploymentError
	if (cleanupError !== undefined) throw cleanupError
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
