import { ethers as ethersLib } from "ethers"

type NetworkConnection = {
	ethers: any
	upgrades?: any
	networkName?: string
}

/**
 * Normalize an address string to EIP-55 checksum format.
 * Lowercases first to avoid EIP-55 validation errors from mixed-case input.
 */
export function checksumAddress(addr: string): string {
	return ethersLib.getAddress(addr.toLowerCase())
}

// Use a consistent key for caching the connection across the entire application
const CONNECTION_KEY = "__symmio_hardhat_connection__"

export async function getConnection(hre: any): Promise<NetworkConnection> {
	const globalAny = globalThis as { [key: string]: Promise<any> | undefined }

	// Check if connection is already cached
	if (!globalAny[CONNECTION_KEY]) {
		// Check if hre already has an ethers instance (e.g., from hardhat-connection.ts)
		if (hre.ethers) {
			// Use the existing ethers instance
			globalAny[CONNECTION_KEY] = Promise.resolve({ ethers: hre.ethers, upgrades: hre.upgrades })
		} else {
			// Create a new connection and cache it
			globalAny[CONNECTION_KEY] = hre.network.connect()
		}
	}
	return globalAny[CONNECTION_KEY]
}

export async function deployProxyWithFallback(
	hre: any,
	factory: any,
	args: unknown[],
	options?: { initializer?: string; kind?: string },
): Promise<any> {
	const { ethers, upgrades } = await getConnection(hre)

	if (upgrades?.deployProxy) {
		return upgrades.deployProxy(factory, args, options)
	}

	const implementation = await factory.deploy()
	await implementation.waitForDeployment()
	const implAddress = await implementation.getAddress()

	// Wait for implementation to be visible to RPC node (L2 race condition)
	for (let attempt = 0; attempt < 10; attempt++) {
		const code = await ethers.provider.getCode(implAddress)
		if (code !== "0x") break
		console.log("  Waiting for implementation to be indexed by RPC... (attempt %d)", attempt + 1)
		await new Promise(r => setTimeout(r, 3000))
	}

	const proxyFactory = await ethers.getContractFactory("LocalERC1967Proxy")
	const initializer = options?.initializer ?? "initialize"

	// Encode the initializer function call data
	const initData = factory.interface.encodeFunctionData(initializer, args)

	const proxy = await proxyFactory.deploy(implAddress, initData)
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
