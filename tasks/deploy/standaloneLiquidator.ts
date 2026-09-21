import { getAddress, isAddress, ZeroAddress } from "ethers"
import fs from "node:fs"

import { loadAddresses } from "../../scripts/utils/file.js"
import { atomicWriteFile } from "../utils/fs.js"
import { requireExecutionConfirmation } from "./executionGuard.js"
import { getConnection } from "./helpers.js"
import { setHyperEVMBigBlocks } from "./hyperevm.js"
import { deploySymmioLiquidator } from "./liquidator.js"
import { ensureLiquidatorMetadata, LIQUIDATOR_METADATA, requireLiquidatorMetadataAuthority } from "./liquidatorMetadata.js"
import { send } from "./tx.js"

const HYPEREVM_CHAIN_IDS = new Set<bigint>([998n, 999n])

function requiredAddress(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (!value || !isAddress(value) || value === ZeroAddress) {
		throw new Error(`${name} is required and must be a non-zero address`)
	}
	return getAddress(value)
}

function parseOperators(raw: string | undefined): string[] {
	const operators = (raw ?? "")
		.split(",")
		.map(value => value.trim())
		.filter(Boolean)
		.map(value => {
			if (!isAddress(value) || value === ZeroAddress) throw new Error(`Invalid OPERATORS address: ${value}`)
			return getAddress(value)
		})
	return [...new Set(operators)]
}

async function requireSuccessfulReceipt(tx: any, label: string): Promise<void> {
	await send(Promise.resolve(tx), label)
}

export async function runStandaloneLiquidator(hre: any): Promise<void> {
	const connection = await getConnection(hre)
	const { ethers } = connection
	const deployedAddresses = loadAddresses()
	const symmioAddress = requiredAddress("SYMMIO_ADDRESS", deployedAddresses.symmioAddress)
	const admin = requiredAddress("ADMIN_PUBLIC_KEY")
	let resumeAddress = process.env.LIQUIDATOR_ADDRESS ? requiredAddress("LIQUIDATOR_ADDRESS") : undefined
	const operators = parseOperators(process.env.OPERATORS)
	const chainId = (await ethers.provider.getNetwork()).chainId
	const execute = requireExecutionConfirmation(chainId)
	const resumeFile = process.env.LIQUIDATOR_RESUME_FILE
	if (resumeFile && fs.existsSync(resumeFile)) {
		const saved = JSON.parse(fs.readFileSync(resumeFile, "utf8"))
		if (saved.chainId !== String(chainId) || saved.core !== symmioAddress || saved.admin !== admin || !isAddress(saved.proxy)) {
			throw new Error(`Liquidator resume record does not match chain, Core and admin: ${resumeFile}`)
		}
		if (resumeAddress && resumeAddress !== getAddress(saved.proxy)) throw new Error("LIQUIDATOR_ADDRESS conflicts with the saved proxy")
		resumeAddress = getAddress(saved.proxy)
	}
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
	console.log(`  Metadata:    ${JSON.stringify(LIQUIDATOR_METADATA)} via setAffiliateMetadata (AFFILIATE_MANAGER_ROLE)`)
	console.log(`  Mode:        ${execute ? "EXECUTE" : "PLAN ONLY"}`)
	if (!execute) {
		console.log(`\nPlan complete. Review it, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}

	const configuredSigners = await ethers.getSigners()
	let signer = configuredSigners[0]
	if (isPersistentLocalhost) {
		const unlocked: string[] = (await ethers.provider.send("eth_accounts", [])).map((value: string) => getAddress(value))
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
	if (!resumeAddress) await requireLiquidatorMetadataAuthority(coreView, signer)
	const roleEntries = ["LIQUIDATOR_ROLE", "PARTYB_LIQUIDATOR_ROLE"].map(name => [name, ethers.id(name)] as const)
	for (const [roleName, role] of roleEntries) {
		if (!(await coreView.isRoleAdmin(signerAddress, role))) {
			throw new Error(`Signer ${signerAddress} is not a role admin for ${roleName} on ${symmioAddress}`)
		}
	}

	let liquidatorAddress = resumeAddress
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

		if (!liquidatorAddress) {
			// This script is the explicit live exception to the local-only low-level task.
			// EXECUTE + CONFIRM_CHAIN_ID were validated above before calling the deploy helper.
			const contract: any = await deploySymmioLiquidator(hre, { symmioAddress, admin, logData: true })
			liquidatorAddress = ethers.getAddress(await contract.getAddress())
			if ((await ethers.provider.getCode(liquidatorAddress)) === "0x") throw new Error(`Deployment produced no code at ${liquidatorAddress}`)
			console.log(`SymmioLiquidator deployed: ${liquidatorAddress}`)
		}

		// Persist the confirmed proxy before any role or metadata setup can fail.
		if (resumeFile)
			atomicWriteFile(resumeFile, `${JSON.stringify({ chainId: String(chainId), core: symmioAddress, admin, proxy: liquidatorAddress }, null, 2)}\n`)
		console.log(`Resume this proxy with LIQUIDATOR_ADDRESS=${liquidatorAddress}`)

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

		await ensureLiquidatorMetadata(ethers, liquidator, symmioAddress, signer)

		console.log(`\nDeployment, wiring and metadata verified: ${liquidatorAddress}`)
	} catch (error) {
		if (liquidatorAddress) console.error(`Setup failed for ${liquidatorAddress}; resume with LIQUIDATOR_ADDRESS=${liquidatorAddress}`)
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
