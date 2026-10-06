import { tasks } from "hardhat"

// Import to initialize the hardhat connection
import "../test/helpers/hardhat-connection.js"
import { Addresses, loadAddresses } from "./utils/file.js"

const deployedAddresses: Addresses = loadAddresses()
const symmioAddress = deployedAddresses.symmioAddress
const admin = process.env.ADMIN_PUBLIC_KEY
const symmioShare = ""
const symmioShareReceiver = ""

// Run the deploy:feeDistributor task
const contract = await tasks.getTask("deploy:feeDistributor").run({
	symmioAddress,
	admin,
	symmioShare,
	symmioShareReceiver,
})
