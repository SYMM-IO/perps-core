import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { deployProxy, erc1967 } from "../../utils/upgrades-shim"

task("deploy:feeDistributor", "Deploys the SymmioFeeDistributor")
	.addOption({ name: "symmioAddress", description: "The address of the Symmio contract", defaultValue: "" })
	.addOption({ name: "admin", description: "The admin address", defaultValue: "" })
	.addOption({ name: "symmioShare", description: "The symmio share", defaultValue: "0" })
	.addOption({ name: "symmioShareReceiver", description: "The symmio share receiver", defaultValue: "" })
	.setAction(async ({ symmioAddress, admin, symmioShareReceiver, symmioShare }, hre) => {
		const { ethers } = hre
		console.log("Running deploy:feeDistributor")

		const [deployer] = await ethers.getSigners()

		console.log("Deploying contracts with the account:", deployer.address)

		// Deploy SymmioFeeDistributor as upgradeable
		const factory = await ethers.getContractFactory("SymmioFeeDistributor")
		const contract = await deployProxy(hre, factory, [admin, symmioAddress, symmioShareReceiver, symmioShare], {
			initializer: "initialize",
			kind: "transparent",
			admin,
		})

		const addresses = {
			proxy: await contract.getAddress(),
			admin: await erc1967(hre).getAdminAddress(await contract.getAddress()),
			implementation: await erc1967(hre).getImplementationAddress(await contract.getAddress()),
		}
		console.log("SymmioFeeDistributor deployed to", addresses)

		return contract
	})
