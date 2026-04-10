import { ethers } from "../../test/helpers/hardhat-connection.js"

const diamond = "0x2Ecc7da3Cc98d341F987C85c3D9FC198570838B5"
const migrationRunner = "0x3d3829fC319B918ed0A26D7e2f59E7E629eE8F3A"
const MIGRATION_ROLE = ethers.id("MIGRATION_ROLE")

async function main() {
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamond)
	const hasRole = await viewFacet.hasRole(migrationRunner, MIGRATION_ROLE)
	console.log(`MIGRATION_ROLE for ${migrationRunner}: ${hasRole}`)

	const [globalPaused] = await (viewFacet as any).pauseState()
	console.log(`Global paused: ${globalPaused}`)
}

main().catch(console.error)
