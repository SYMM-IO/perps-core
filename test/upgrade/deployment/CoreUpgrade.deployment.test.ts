import { assertCoreDeployments } from "../../../tasks/deploy/arbitrumCoreUpgrade.js"
import { ethers, hre } from "../../helpers/hardhat-connection.js"
import { rejects } from "../helpers/CoreUpgrade.fixture.js"

describe("Current Core upgrade safety gates (deployment)", function () {
	it("requires the full deployment manifest and rejects reused or missing artifact evidence", async () => {
		await rejects(() => assertCoreDeployments(hre, ethers, undefined), /missing/)
		await rejects(() => assertCoreDeployments(hre, ethers, { libraries: {}, facets: {} }), /complete current manifest/)
	})
})
