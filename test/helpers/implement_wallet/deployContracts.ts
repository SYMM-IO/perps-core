// scripts/deploy-and-dump.ts
import fs from "fs"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"

import { initializeFixture } from "../../../test/Initialize.fixture.js"
import { User } from "../../models/User.js"
import { decimal } from "../../utils/Common.js"
import { ethers, network } from "../hardhat-connection.js"

// ^ you already use this in tests; it deploys everything and returns the context

async function main() {
	// Initialize/deploy using your existing fixture
	const context = await initializeFixture()

	const addrs = {
		chainId: Number((await ethers.provider.getNetwork()).chainId),
		instantLayer: await context.instantLayer.getAddress(),
		diamond: context.diamond as string, // or await ctx.partyAFacet.getAddress() if you prefer
		multiAccount: await context.accountManager.getAddress(),
		// add more if you want them in the UI…
	}

	let partyA1: User = new User(context, context.signers.user)
	await partyA1.setup()
	await partyA1.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))

	const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./") // put JSON next to your index.html
	const outFile = path.join(outDir, "addresses.json")
	fs.mkdirSync(outDir, { recursive: true })
	fs.writeFileSync(outFile, JSON.stringify(addrs, null, 2))
	console.log("Wrote", outFile, "\n", addrs)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(e => {
		console.error(e)
		process.exit(1)
	})
}
