import ERC1967ProxyArtifact from "@openzeppelin/contracts/build/contracts/ERC1967Proxy.json" with { type: "json" }
import ProxyAdminArtifact from "@openzeppelin/contracts/build/contracts/ProxyAdmin.json" with { type: "json" }
import TransparentUpgradeableProxyArtifact from "@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json" with { type: "json" }
import { ethers } from "ethers"
import type { ContractFactory } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"

type DeployProxyOptions = {
	initializer?: string | false
	kind?: "transparent" | "erc1967"
	admin?: string
}

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

async function readAddressSlot(hre: HardhatRuntimeEnvironment, address: string, slot: string): Promise<string> {
	const value = await hre.ethers.provider.getStorage(address, slot)
	return ethers.getAddress("0x" + value.slice(26))
}

export const erc1967 = (hre: HardhatRuntimeEnvironment) => ({
	getAdminAddress: (address: string) => readAddressSlot(hre, address, ADMIN_SLOT),
	getImplementationAddress: (address: string) => readAddressSlot(hre, address, IMPLEMENTATION_SLOT),
})

export async function deployProxy(hre: HardhatRuntimeEnvironment, factory: ContractFactory, args: unknown[] = [], options: DeployProxyOptions = {}) {
	const initializer = options.initializer === undefined ? "initialize" : options.initializer
	const kind = options.kind ?? "transparent"
	const [defaultSigner] = await hre.ethers.getSigners()
	const admin = options.admin ?? defaultSigner.address

	const implementation = await factory.deploy()
	await implementation.waitForDeployment()

	let initData = "0x"
	if (initializer !== false) {
		initData = factory.interface.encodeFunctionData(initializer, args)
	}

	let proxy
	if (kind === "erc1967") {
		const { abi, bytecode } = ERC1967ProxyArtifact as any
		const ProxyFactory = new hre.ethers.ContractFactory(abi, bytecode, defaultSigner)
		proxy = await ProxyFactory.deploy(await implementation.getAddress(), initData)
	} else {
		const { abi, bytecode } = ProxyAdminArtifact as any
		const ProxyAdminFactory = new hre.ethers.ContractFactory(abi, bytecode, defaultSigner)
		const proxyAdmin = await ProxyAdminFactory.deploy()
		if (admin && admin !== defaultSigner.address) {
			await (await proxyAdmin.transferOwnership(admin)).wait()
		}

		const { abi: transpAbi, bytecode: transpBytecode } = TransparentUpgradeableProxyArtifact as any
		const ProxyFactory = new hre.ethers.ContractFactory(transpAbi, transpBytecode, defaultSigner)
		proxy = await ProxyFactory.deploy(await implementation.getAddress(), await proxyAdmin.getAddress(), initData)
	}

	await proxy.waitForDeployment()
	return factory.attach(await proxy.getAddress())
}
