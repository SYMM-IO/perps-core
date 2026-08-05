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

/**
 * Task options declared STRING_WITHOUT_DEFAULT arrive as `undefined` when omitted, and
 * then reach checksumAddress(), which fails with an opaque
 * "Cannot read properties of undefined (reading 'toLowerCase')". Name the missing flag.
 */
export function requireArg(value: string | undefined, flag: string): string {
	if (!value) throw new Error(`Missing required option --${flag}`)
	return value
}

export async function getConnection(hre: any): Promise<NetworkConnection> {
	const globalAny = globalThis as unknown as { [key: string]: Promise<any> | undefined }

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

// ERC1967 storage slots (EIP-1967)
const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ERC1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

export async function getUpgradeAddresses(upgrades: any, contract: any): Promise<{ admin?: string; implementation?: string }> {
	const proxyAddress = await contract.getAddress()

	if (upgrades?.erc1967) {
		return {
			admin: await upgrades.erc1967.getAdminAddress(proxyAddress),
			implementation: await upgrades.erc1967.getImplementationAddress(proxyAddress),
		}
	}

	// Fallback: read ERC1967 storage slots directly. Used when hardhat-upgrades
	// is unavailable and deployProxyWithFallback used LocalERC1967Proxy (a plain
	// ERC1967Proxy with no separate admin contract — admin slot will be zero).
	const provider = contract.runner?.provider ?? contract.provider
	if (!provider) return {}

	const readSlot = async (slot: string): Promise<string | undefined> => {
		const raw = await provider.getStorage(proxyAddress, slot)
		const addr = "0x" + raw.slice(-40)
		if (addr === "0x" + "0".repeat(40)) return undefined
		return ethersLib.getAddress(addr)
	}

	return {
		implementation: await readSlot(ERC1967_IMPLEMENTATION_SLOT),
		admin: await readSlot(ERC1967_ADMIN_SLOT),
	}
}
