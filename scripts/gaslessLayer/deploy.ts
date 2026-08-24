import { network } from "hardhat"

import { isHyperEVMChainId, setHyperEVMBigBlocksForSigner } from "../../tasks/deploy/hyperevm.js"
import { deployGaslessLayerLibraries, gaslessLayerFactoryOptions } from "./layer-libraries.js"

/**
 * Deploys the GaslessLayer implementation + ERC1967 (UUPS) proxy and initializes it.
 * Run: `npx hardhat run scripts/gaslessLayer/deploy.ts --network <name>` with the
 * gaslessLayer variables from .env.example configured.
 */
async function main() {
	const { ethers } = await network.connect()
	const [deployer] = await ethers.getSigners()
	const chainId = (await ethers.provider.getNetwork()).chainId
	const isHyperEVM = isHyperEVMChainId(chainId)
	console.log("Deployer:", deployer.address)

	const need = (k: string): string => {
		const v = process.env[k]
		if (!v) throw new Error(`Missing required env var: ${k}`)
		return v
	}

	const CORE = need("SYMMIO_CORE")
	const ACCOUNT_LAYER = need("SYMMIO_ACCOUNT_LAYER")
	const INSTANT_LAYER = need("SYMMIO_INSTANT_LAYER")
	const TREASURY = process.env.TREASURY || deployer.address
	const DEPOSIT_FEE = process.env.DEPOSIT_FEE || "2000000"
	const MINIMUM_DEPOSIT = process.env.MINIMUM_DEPOSIT || "5000000"

	if (isHyperEVM) {
		console.log(`Detected HyperEVM (chainId ${chainId}) - enabling big blocks before contract deployment...`)
		await setHyperEVMBigBlocksForSigner(deployer, chainId, true)
		console.log("")
	}

	try {
		const libraries = await deployGaslessLayerLibraries(ethers, deployer, console.log)
		console.log("GaslessNativeGasTopUpLib:", libraries.GaslessNativeGasTopUpLib)
		console.log("GaslessOperationalFeeLib:", libraries.GaslessOperationalFeeLib)
		console.log("GaslessWalletDeployerLib:", libraries.GaslessWalletDeployerLib)
		console.log("GaslessWalletExecutionLib:", libraries.GaslessWalletExecutionLib)

		const Gateway = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(libraries, deployer))
		const impl = await Gateway.deploy()
		await impl.waitForDeployment()
		console.log("Implementation:", await impl.getAddress())

		const initData = Gateway.interface.encodeFunctionData("initialize", [
			deployer.address,
			CORE,
			ACCOUNT_LAYER,
			INSTANT_LAYER,
			TREASURY,
			DEPOSIT_FEE,
			MINIMUM_DEPOSIT,
		])

		const Proxy = await ethers.getContractFactory("LayerProxy")
		const proxy = await Proxy.deploy(await impl.getAddress(), initData)
		await proxy.waitForDeployment()
		console.log("GaslessLayer (proxy):", await proxy.getAddress())
	} finally {
		if (isHyperEVM) {
			console.log("")
			console.log("Contract deployment complete - restoring HyperEVM fast blocks...")
			try {
				await setHyperEVMBigBlocksForSigner(deployer, chainId, false)
			} catch (err: any) {
				console.error("Failed to disable big blocks. Run manually:")
				console.error("  npx hardhat hyperevm:disable-big-blocks --network hyperevm")
				console.error(err)
			}
		}
	}

	console.log("\nPost-deploy wiring required:")
	console.log("  1. InstantLayer admin: grant this gateway OPERATOR_ROLE (registers it as executor).")
	console.log("  2. Symmio core: call registerOperationalFeeCharger(gatewayAddr) with FEE_ADMIN_ROLE (0.8.6+).")
	console.log("  3. Gateway: grant RELAYER_ROLE to your off-chain bot keys.")
}

main().catch(e => {
	console.error(e)
	process.exitCode = 1
})
