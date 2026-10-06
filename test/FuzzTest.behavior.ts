import fsPromise from "fs/promises"
import { dirname, join } from "path"
import { interval } from "rxjs"
import { fileURLToPath } from "url"

import { ethers } from "./helpers/hardhat-connection.js"
import { Hedger } from "./models/Hedger.js"
import { HedgerController } from "./models/HedgerController.js"
import { ManagedError } from "./models/ManagedError.js"
import { createRunContext, RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { UserController } from "./models/UserController.js"
import { QuoteCheckpoint } from "./models/quoteCheckpoint.js"
import { decimal } from "./utils/Common.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

export function shouldBehaveLikeFuzzTest(): void {
	beforeEach(async function () {
		const addresses = JSON.parse("" + (await fsPromise.readFile(join(__dirname, "..", "output", "addresses.json"))))
		this.context = await createRunContext(addresses.v3Address, addresses.collateralAddress)
	})

	it("Should run fine", async function () {
		const context: RunContext = this.context
		const manager = context.manager
		const checkpoint = QuoteCheckpoint.getInstance()

		const uSigner = await ethers.getImpersonatedSigner(ethers.Wallet.createRandom().address)
		const user = new User(context, uSigner)
		await user.setup()
		await user.setNativeBalance(100n ** 18n)
		const userController = new UserController(manager, user, checkpoint)

		const hSigner = await ethers.getImpersonatedSigner(ethers.Wallet.createRandom().address)
		const hedger = new Hedger(context, hSigner)
		await hedger.setup()
		await hedger.setNativeBalance(100n ** 18n)
		await hedger.setBalances(10n ** 50n, 10n ** 50n)
		await hedger.register()
		const hedgerController = new HedgerController(manager, hedger, checkpoint)

		await userController.start()
		await hedgerController.start()
		await user.setBalances(decimal(100000), decimal(100000), decimal(100000))

		const subscription = interval(1000).subscribe(() => {
			manager.actionsLoop.next({
				title: "SendQuote",
				action: () => {
					return new Promise((resolve, reject) => {
						if (manager.getPauseState()) {
							reject()
						}
						userController
							.sendQuote()
							.then(() => {
								resolve()
							})
							.catch(error => {
								if (error instanceof ManagedError) {
									if (error.message.indexOf("Insufficient funds available") >= 0) {
										console.error(error.message)
										subscription.unsubscribe()
									} else if (error.message.indexOf("Too many open quotes") >= 0) {
										// DO nothing
									}
									resolve()
								} else {
									reject(error)
									process.exitCode = 1
									console.error(error)
								}
							})
					})
				},
			})
		})

		await new Promise(r => setTimeout(r, 200000))
	})
}
