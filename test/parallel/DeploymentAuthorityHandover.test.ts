import { expect } from "chai"

import { DEPLOYER_SETUP_ROLES } from "../../tasks/deploy/deployAll.js"
import { grantSymbolManagerOperatorRoles } from "../../tasks/deploy/symbolManager.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("fresh deployment authority handover", function () {
	it("temporarily grants the provider admin role", function () {
		expect(DEPLOYER_SETUP_ROLES).to.include("PROVIDER_ADMIN_ROLE")
	})

	it("hands fresh SymbolManager admin to governance after operator setup", async function () {
		const [deployer, admin, operator] = await ethers.getSigners()
		const manager = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(deployer.address, deployer.address)
		await grantSymbolManagerOperatorRoles(hre, {
			symbolManagerAddress: await manager.getAddress(),
			operator: operator.address,
			finalAdmin: admin.address,
			renounceTemporaryAdmin: true,
		})
		expect(await manager.hasRole(ethers.ZeroHash, admin.address)).to.equal(true)
		expect(await manager.hasRole(ethers.ZeroHash, deployer.address)).to.equal(false)
		expect(await manager.hasRole(await manager.SYMBOL_ADDER_ROLE(), operator.address)).to.equal(true)
		expect(await manager.hasRole(await manager.SYMBOL_REMOVER_ROLE(), operator.address)).to.equal(true)
	})
})
