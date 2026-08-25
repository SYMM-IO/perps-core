import { createDeployedContract, type DeploymentCheckpoint, saveCheckpoint } from "./checkpoint.js"
import { recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"
import { logger } from "./logger.js"
import { create2Record, deployContract, type VanityContext } from "./vanityDeploy.js"

export const GASLESS_LAYER_FQN = "contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer"
export const LOCAL_ERC1967_PROXY_FQN = "contracts/helpers/utils/LocalERC1967Proxy.sol:LocalERC1967Proxy"

export const GASLESS_LIBRARY_FQNS = {
	GaslessNativeGasTopUpLib: "contracts/gaslessLayer/libraries/GaslessNativeGasTopUpLib.sol:GaslessNativeGasTopUpLib",
	GaslessOperationalFeeLib: "contracts/gaslessLayer/libraries/GaslessOperationalFeeLib.sol:GaslessOperationalFeeLib",
	GaslessWalletDeployerLib: "contracts/gaslessLayer/libraries/GaslessWalletDeployerLib.sol:GaslessWalletDeployerLib",
	GaslessWalletExecutionLib: "contracts/gaslessLayer/libraries/GaslessWalletExecutionLib.sol:GaslessWalletExecutionLib",
} as const

export type GaslessLayerLibraries = Record<keyof typeof GASLESS_LIBRARY_FQNS, string>

export type GaslessLayerVerificationRecord = {
	name: string
	address: string
	constructorArguments: unknown[]
	libraries?: Record<string, string>
}

export type GaslessSelectorFee = { selector: string; configured: boolean; amount: string }

export interface GaslessLayerResolvedConfig {
	address: string
	implementation: string
	admin: string
	deployer: string
	core: string
	accountLayer: string
	instantLayer: string
	collateral: string
	treasury: string
	depositFee: string
	minimumDeposit: string
	defaultSelectorFee: string
	dailyFreeOpsLimit: string
	revertWhenFreeQuotaExhausted: boolean
	dailySponsoredNativeLimit: string
	revertWhenNativeSponsorLimitExhausted: boolean
	maxNativeGasTopUpAmount: string
	nativeGasTopUpFeeBps: number
	relayers: string[]
	selectorFees: GaslessSelectorFee[]
}

async function deployLibrary(
	hre: any,
	checkpoint: DeploymentCheckpoint,
	vanity: VanityContext | null,
	name: keyof typeof GASLESS_LIBRARY_FQNS,
	libraries?: Record<string, string>,
): Promise<string> {
	checkpoint.contracts.gaslessLayer ||= {}
	checkpoint.contracts.gaslessLayer.libraries ||= {}
	const existing = checkpoint.contracts.gaslessLayer.libraries[name]
	if (existing) {
		logger.reused(name, existing.address)
		return existing.address
	}
	const { ethers } = await getConnection(hre)
	const factory = await ethers.getContractFactory(name, libraries ? { libraries } : undefined)
	const result = await deployContract(vanity, {
		key: `gaslessLayer/${name}`,
		component: `contracts.gaslessLayer.libraries.${name}`,
		label: name,
		factory,
		checkpoint,
	})
	checkpoint.contracts.gaslessLayer.libraries[name] = createDeployedContract(result.address, [], create2Record(result))
	saveCheckpoint(checkpoint)
	logger.deployed(name, result.address)
	return result.address
}

export function createGaslessLayerVerificationRecords(
	factory: { interface: { encodeFunctionData: (name: string, args: readonly unknown[]) => string } },
	addresses: { proxy: string; implementation: string; libraries: GaslessLayerLibraries },
	initializerArgs: readonly unknown[],
): GaslessLayerVerificationRecord[] {
	const initData = factory.interface.encodeFunctionData("initialize", initializerArgs)
	return [
		...Object.entries(addresses.libraries).map(([name, address]) => ({
			name: GASLESS_LIBRARY_FQNS[name as keyof typeof GASLESS_LIBRARY_FQNS],
			address,
			constructorArguments: [],
			...(name === "GaslessWalletExecutionLib" ? { libraries: { GaslessWalletDeployerLib: addresses.libraries.GaslessWalletDeployerLib } } : {}),
		})),
		{
			name: GASLESS_LAYER_FQN,
			address: addresses.implementation,
			constructorArguments: [],
			libraries: addresses.libraries,
		},
		{
			name: LOCAL_ERC1967_PROXY_FQN,
			address: addresses.proxy,
			constructorArguments: [addresses.implementation, initData],
		},
	]
}

export async function deployGaslessLayer(
	hre: any,
	input: {
		admin: string
		core: string
		accountLayer: string
		instantLayer: string
		treasury: string
		depositFee: string
		minimumDeposit: string
		checkpoint: DeploymentCheckpoint
		vanity?: VanityContext | null
	},
): Promise<{
	contract: any
	address: string
	implementation: string
	libraries: GaslessLayerLibraries
	records: GaslessLayerVerificationRecord[]
}> {
	const { ethers, upgrades } = await getConnection(hre)
	const checkpoint = input.checkpoint
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.gaslessLayer")

	const GaslessWalletDeployerLib = await deployLibrary(hre, checkpoint, input.vanity || null, "GaslessWalletDeployerLib")
	const libraries: GaslessLayerLibraries = {
		GaslessNativeGasTopUpLib: await deployLibrary(hre, checkpoint, input.vanity || null, "GaslessNativeGasTopUpLib"),
		GaslessOperationalFeeLib: await deployLibrary(hre, checkpoint, input.vanity || null, "GaslessOperationalFeeLib"),
		GaslessWalletDeployerLib,
		GaslessWalletExecutionLib: await deployLibrary(hre, checkpoint, input.vanity || null, "GaslessWalletExecutionLib", {
			GaslessWalletDeployerLib,
		}),
	}
	const factory = await ethers.getContractFactory("GaslessLayer", { libraries })
	const initializerArgs = [
		input.admin,
		input.core,
		input.accountLayer,
		input.instantLayer,
		input.treasury,
		input.depositFee,
		input.minimumDeposit,
	] as const

	let contract: any
	if (checkpoint.contracts.gaslessLayer?.proxy) {
		contract = factory.attach(checkpoint.contracts.gaslessLayer.proxy.address)
		logger.reused("GaslessLayer", checkpoint.contracts.gaslessLayer.proxy.address)
	} else {
		contract = await deployProxyWithFallback(hre, factory, [...initializerArgs], {
			initializer: "initialize",
			label: "GaslessLayer",
			checkpoint,
			implementationComponent: "deployments.gaslessLayer.implementation",
			proxyComponent: "contracts.gaslessLayer.proxy",
			unsafeAllow: ["external-library-linking"],
		} as any)
	}
	const address = await contract.getAddress()
	const upgradeAddresses = await getUpgradeAddresses(upgrades, contract)
	if (!upgradeAddresses.implementation) throw new Error(`GaslessLayer proxy ${address} has no ERC1967 implementation address`)
	const implementation = upgradeAddresses.implementation
	if ((await ethers.provider.getCode(implementation)) === "0x") {
		throw new Error(`GaslessLayer implementation ${implementation} has no deployed code`)
	}
	const records = createGaslessLayerVerificationRecords(factory, { proxy: address, implementation, libraries }, initializerArgs)
	checkpoint.contracts.gaslessLayer ||= {}
	checkpoint.contracts.gaslessLayer.proxy = createDeployedContract(address, records.at(-1)!.constructorArguments)
	checkpoint.contracts.gaslessLayer.implementation = createDeployedContract(implementation, [])
	saveCheckpoint(checkpoint)
	logger.deployed("GaslessLayer (Proxy)", address)
	logger.deployed("GaslessLayer (Implementation)", implementation)
	return { contract, address, implementation, libraries, records }
}
