import { run } from "hardhat"
import { Addresses, loadAddresses } from "./utils/file"

async function main() {
	const symmioAddress = ""
	const admin = ""
	const symmioShare = "150000000000000000"
	const symmioShareReceiver = ""

	const contract = await run("deploy:feeDistributor", {
		symmioAddress,
		admin,
		symmioShare,
		symmioShareReceiver,
	})
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
