import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "./hardhat-connection.js"

/** Historical rounding releases keep their deployed PauseControlFacet unchanged. */
export async function initializeLegacyPauseFixture() {
	const context = await initializeFixture()
	const legacy = await (await ethers.getContractFactory("LegacyGlobalPauseFacet")).deploy()
	const cut = await ethers.getContractAt("DiamondCutFacet", context.diamond)
	await cut.diamondCut(
		[
			{
				facetAddress: await legacy.getAddress(),
				action: 1,
				functionSelectors: [context.pauseControlFacet.interface.getFunction("pauseGlobal")!.selector],
			},
		],
		ethers.ZeroAddress,
		"0x",
	)
	await context.controlFacet.grantRole(context.signers.admin.address, ethers.id("PAUSER_ROLE"))
	return context
}
