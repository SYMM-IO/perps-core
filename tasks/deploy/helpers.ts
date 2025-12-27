type NetworkConnection = {
	ethers: any
	upgrades?: any
}

export async function getConnection(hre: any): Promise<NetworkConnection> {
	const connectionKey = Symbol.for("symmio.hardhat.connection")
	const globalAny = globalThis as { [key: symbol]: Promise<any> | undefined }
	if (!globalAny[connectionKey]) {
		globalAny[connectionKey] = hre.network.connect()
	}
	return globalAny[connectionKey]
}

export async function deployProxyWithFallback(
	hre: any,
	factory: any,
	args: unknown[],
	options?: { initializer?: string; kind?: string },
): Promise<any> {
	const { upgrades } = await getConnection(hre)

	if (upgrades?.deployProxy) {
		return upgrades.deployProxy(factory, args, options)
	}

	const implementation = await factory.deploy()
	await implementation.waitForDeployment()

	const { ethers } = await getConnection(hre)
	const proxyFactory = await ethers.getContractFactory("LocalERC1967Proxy")
	const initializer = options?.initializer ?? "initialize"
	let initData = "0x"
	if (typeof factory.interface?.encodeFunctionData === "function") {
		try {
			initData = factory.interface.encodeFunctionData(initializer, args)
		} catch {
			initData = "0x"
		}
	}

	const proxy = await proxyFactory.deploy(await implementation.getAddress(), initData)
	await proxy.waitForDeployment()

	return factory.attach(await proxy.getAddress())
}

export async function getUpgradeAddresses(upgrades: any, contract: any): Promise<{ admin?: string; implementation?: string }> {
	if (!upgrades?.erc1967) {
		return {}
	}

	return {
		admin: await upgrades.erc1967.getAdminAddress(await contract.getAddress()),
		implementation: await upgrades.erc1967.getImplementationAddress(await contract.getAddress()),
	}
}
