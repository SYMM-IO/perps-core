import { ethers as ethersLib } from "ethers"

import { setDataScope } from "../utils/fs.js"
import type { DeploymentCheckpoint } from "./checkpoint.js"
import { checkpointDeployment, recoverCheckpointDeployment } from "./deploymentRecovery.js"
import { logger } from "./logger.js"
import { assertStandaloneDeploymentTaskAllowed as assertStandaloneDeploymentNetworkAllowed } from "./safety.js"
import { confirmDeployment } from "./tx.js"

type NetworkConnection = {
	ethers: any
	upgrades?: any
	networkName?: string
	networkConfig?: { type?: string }
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
		// Prefer the real Hardhat 3 connection even when a compatibility helper has also
		// attached hre.ethers. It carries networkName/networkConfig, which record scoping
		// needs to distinguish an EDR fork from a live RPC with the same chain id.
		if (hre.network?.getOrCreate) {
			globalAny[CONNECTION_KEY] = hre.network.getOrCreate()
		} else if (hre.ethers) {
			globalAny[CONNECTION_KEY] = Promise.resolve({
				ethers: hre.ethers,
				upgrades: hre.upgrades,
				networkName: hre.networkName,
				networkConfig: hre.networkConfig,
			})
		} else {
			throw new Error("Hardhat runtime has neither network.getOrCreate() nor an ethers connection")
		}
	}
	const connection = await globalAny[CONNECTION_KEY]
	if (!connection?.ethers?.provider) throw new Error("Hardhat network connection has no ethers provider")
	const chainId = (await connection.ethers.provider.getNetwork()).chainId
	const isSimulatedNetwork = connection.networkConfig?.type === "edr-simulated"
	// Every standalone deploy task reaches this helper before reading or writing its
	// verification records. Scope records here so direct tasks and deploy:system cannot
	// silently share legacy tasks/data/*.json across chains (or across live/fork runs).
	setDataScope(chainId, { simulated: isSimulatedNetwork })
	return connection
}

/** Guard a public low-level deployment task before it can broadcast to a live RPC. */
export async function assertStandaloneDeploymentTaskAllowed(hre: any, taskName: string, liveWorkflow?: string): Promise<void> {
	const connection = await getConnection(hre)
	const chainId = (await connection.ethers.provider.getNetwork()).chainId
	const isSimulated = connection.networkConfig?.type === "edr-simulated"
	assertStandaloneDeploymentNetworkAllowed(taskName, chainId, isSimulated, liveWorkflow)
}

export async function deployProxyWithFallback(
	hre: any,
	factory: any,
	args: unknown[],
	options?: {
		initializer?: string
		kind?: string
		label?: string
		checkpoint?: DeploymentCheckpoint
		implementationComponent?: string
		proxyComponent?: string
	},
): Promise<any> {
	const { ethers, upgrades } = await getConnection(hre)
	const label = options?.label || "proxy"
	const {
		label: _label,
		checkpoint,
		implementationComponent = `deployments.${label}.implementation`,
		proxyComponent = `deployments.${label}.proxy`,
		...upgradeOptions
	} = options || {}

	const recoveredProxy = await recoverCheckpointDeployment(checkpoint, ethers.provider, proxyComponent)
	if (recoveredProxy) {
		logger.info(`  ↻ Recovered ${label} proxy at ${recoveredProxy} from its confirmed creation transaction`)
		return factory.attach(recoveredProxy)
	}

	if (upgrades?.deployProxy) {
		const proxy = await upgrades.deployProxy(factory, args, upgradeOptions)
		await confirmDeployment(proxy, `${label} proxy`, checkpointDeployment(checkpoint, proxyComponent))
		return proxy
	}

	const recoveredImplementation = await recoverCheckpointDeployment(checkpoint, ethers.provider, implementationComponent)
	if (recoveredImplementation) {
		logger.info(`  ↻ Recovered ${label} implementation at ${recoveredImplementation} from its confirmed creation transaction`)
	}
	const implementation = recoveredImplementation ? factory.attach(recoveredImplementation) : await factory.deploy()
	const implAddress = recoveredImplementation
		? recoveredImplementation
		: await confirmDeployment(implementation, `${label} implementation`, checkpointDeployment(checkpoint, implementationComponent))

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
	await confirmDeployment(proxy, `${label} proxy`, checkpointDeployment(checkpoint, proxyComponent, [implAddress, initData]))

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
