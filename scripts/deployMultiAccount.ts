import { tasks } from "hardhat"
import { Addresses, loadAddresses, saveAddresses } from "./utils/file.js"

// Import to initialize the hardhat connection
import "../test/helpers/hardhat-connection.js"

const deployedAddresses: Addresses = loadAddresses()
const symmioAddress = deployedAddresses.symmioAddress
const admin = process.env.ADMIN_PUBLIC_KEY

// Run the deploy:multiAccount task
const contract = await tasks.getTask("deploy:multiAccount").run({
	symmioAddress,
	admin,
	logData: true,
})

deployedAddresses.multiAccountAddress = contract.address
saveAddresses(deployedAddresses)
