import { ethers } from "../../test/helpers/hardhat-connection.js"

const IL_ADDRESS = "0xbf40BECa9Fb74FB67dF4a5C9C99eBAD35e616fFd"
const SAFE_ADDRESS = "0x0C83Ff10E8255Df41e71006eE6523A23024AAFC4"

async function main() {
	const il = await ethers.getContractAt("InstantLayer", IL_ADDRESS)
	const SETTER_ROLE = await il.SETTER_ROLE()
	const DEFAULT_ADMIN_ROLE = await il.DEFAULT_ADMIN_ROLE()
	const hasSetterRole = await il.hasRole(SETTER_ROLE, SAFE_ADDRESS)
	const hasAdminRole = await il.hasRole(DEFAULT_ADMIN_ROLE, SAFE_ADDRESS)

	console.log(`InstantLayer:               ${IL_ADDRESS}`)
	console.log(`Safe:                       ${SAFE_ADDRESS}`)
	console.log(`SETTER_ROLE hash:           ${SETTER_ROLE}`)
	console.log(`Safe has SETTER_ROLE:       ${hasSetterRole}`)
	console.log(`Safe has DEFAULT_ADMIN_ROLE: ${hasAdminRole}`)
}

main().catch(e => {
	console.error(e)
	process.exitCode = 1
})
