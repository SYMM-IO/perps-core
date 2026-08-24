export type GaslessLayerLibraryAddresses = {
	GaslessNativeGasTopUpLib: string
	GaslessOperationalFeeLib: string
	GaslessWalletDeployerLib: string
	GaslessWalletExecutionLib: string
}

type DeployLogger = (message?: any, ...optionalParams: any[]) => void

export async function deployGaslessLayerLibraries(ethers: any, signer?: any, log: DeployLogger = () => {}): Promise<GaslessLayerLibraryAddresses> {
	log("Deploying GaslessNativeGasTopUpLib...")
	const nativeTopUpFactory = signer
		? await ethers.getContractFactory("GaslessNativeGasTopUpLib", signer)
		: await ethers.getContractFactory("GaslessNativeGasTopUpLib")
	const nativeTopUpLib = await nativeTopUpFactory.deploy()
	log("GaslessNativeGasTopUpLib tx:", nativeTopUpLib.deploymentTransaction()?.hash)
	await nativeTopUpLib.waitForDeployment()
	const nativeTopUpLibAddress = await nativeTopUpLib.getAddress()

	log("Deploying GaslessOperationalFeeLib...")
	const operationalFeeFactory = signer
		? await ethers.getContractFactory("GaslessOperationalFeeLib", signer)
		: await ethers.getContractFactory("GaslessOperationalFeeLib")
	const operationalFeeLib = await operationalFeeFactory.deploy()
	log("GaslessOperationalFeeLib tx:", operationalFeeLib.deploymentTransaction()?.hash)
	await operationalFeeLib.waitForDeployment()
	const operationalFeeLibAddress = await operationalFeeLib.getAddress()

	log("Deploying GaslessWalletDeployerLib...")
	const deployerFactory = signer
		? await ethers.getContractFactory("GaslessWalletDeployerLib", signer)
		: await ethers.getContractFactory("GaslessWalletDeployerLib")
	const deployerLib = await deployerFactory.deploy()
	log("GaslessWalletDeployerLib tx:", deployerLib.deploymentTransaction()?.hash)
	await deployerLib.waitForDeployment()
	const deployerLibAddress = await deployerLib.getAddress()

	log("Deploying GaslessWalletExecutionLib...")
	const executionFactoryOptions = signer
		? { signer, libraries: { GaslessWalletDeployerLib: deployerLibAddress } }
		: { libraries: { GaslessWalletDeployerLib: deployerLibAddress } }
	const executionFactory = await ethers.getContractFactory("GaslessWalletExecutionLib", executionFactoryOptions)
	const executionLib = await executionFactory.deploy()
	log("GaslessWalletExecutionLib tx:", executionLib.deploymentTransaction()?.hash)
	await executionLib.waitForDeployment()
	const executionLibAddress = await executionLib.getAddress()

	return {
		GaslessNativeGasTopUpLib: nativeTopUpLibAddress,
		GaslessOperationalFeeLib: operationalFeeLibAddress,
		GaslessWalletDeployerLib: deployerLibAddress,
		GaslessWalletExecutionLib: executionLibAddress,
	}
}

export function gaslessLayerFactoryOptions(libraries: GaslessLayerLibraryAddresses, signer?: any) {
	return signer ? { signer, libraries } : { libraries }
}
