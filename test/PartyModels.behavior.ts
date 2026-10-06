import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import type { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { logDetailedDebug, logger } from "./utils/LoggerUtils.js"
import { randomBigNumber, setRandomSeed } from "./utils/RandomUtils.js"

const userAddress = "0x00000000000000000000000000000000000000a1"
const hedgerAddress = "0x00000000000000000000000000000000000000b1"

function signer(address: string): HardhatEthersSigner {
	return {
		address,
		getAddress: async () => address,
	} as HardhatEthersSigner
}

function position(id: number): QuoteStructOutput {
	return {
		id: BigInt(id),
		openedPrice: 200_000n * 10n ** 18n,
		quantity: 1n,
		closedAmount: 1n,
		positionType: BigInt(PositionType.LONG),
	} as QuoteStructOutput
}

function offsetPager(total: number, starts: number[]): (start: bigint | number, size: bigint | number) => Promise<QuoteStructOutput[]> {
	const positions = Array.from({ length: total }, (_, index) => position(index + 1))
	return async (rawStart, rawSize) => {
		const start = Number(rawStart)
		const size = Number(rawSize)
		if (starts.includes(start)) throw new Error(`pagination repeated start offset ${start}`)
		starts.push(start)
		return positions.slice(start, start + size)
	}
}

function minedTransaction(onMined?: () => void) {
	return Promise.resolve({
		wait: async () => {
			onMined?.()
			return { logs: [] }
		},
	})
}

export function shouldBehaveLikePartyModels(): void {
	describe("position pagination", function () {
		it("advances User.getOpenPositions by the number of returned rows", async function () {
			const starts: number[] = []
			const context = {
				viewFacetQuote: {
					getPartyAOpenPositions: async (_partyA: string, start: bigint | number, size: bigint | number) => offsetPager(31, starts)(start, size),
				},
			} as unknown as RunContext
			const user = new User(context, signer(userAddress))

			const positions = await user.getOpenPositions()

			expect(starts).to.deep.equal([0, 30])
			expect(positions.map(({ id }) => id)).to.deep.equal(Array.from({ length: 31 }, (_, index) => BigInt(index + 1)))
		})

		it("requests a final empty page for an exact page-size multiple", async function () {
			const starts: number[] = []
			const page = offsetPager(30, starts)
			const context = {
				viewFacetQuote: {
					getPartyAOpenPositions: async (_partyA: string, start: bigint | number, size: bigint | number) => page(start, size),
				},
			} as unknown as RunContext
			const user = new User(context, signer(userAddress))

			expect(await user.getOpenPositions()).to.have.length(30)
			expect(starts).to.deep.equal([0, 30])
		})

		it("advances the pages consumed by Hedger.getUpnl", async function () {
			const starts: number[] = []
			const page = offsetPager(31, starts)
			const context = {
				viewFacetQuote: {
					getPartyBOpenPositions: async (_partyB: string, _partyA: string, start: bigint | number, size: bigint | number) => page(start, size),
				},
			} as unknown as RunContext
			const hedger = new Hedger(context, signer(hedgerAddress))

			expect(await hedger.getUpnl(userAddress)).to.equal(0n)
			expect(starts).to.deep.equal([0, 30])
		})
	})

	describe("lazy detailed logging", function () {
		let originalIsLevelEnabled: typeof logger.isLevelEnabled
		let originalDetailedDebug: typeof logger.detailedDebug

		beforeEach(function () {
			originalIsLevelEnabled = logger.isLevelEnabled
			originalDetailedDebug = logger.detailedDebug
		})

		afterEach(function () {
			logger.isLevelEnabled = originalIsLevelEnabled
			logger.detailedDebug = originalDetailedDebug
			setRandomSeed(undefined)
		})

		it("does not read User diagnostics when detailed logging is disabled", async function () {
			let diagnosticReads = 0
			let mined = 0
			logger.isLevelEnabled = () => false
			const context = {
				partyAFacet: {
					connect: () => ({
						requestToCancelQuote: () => minedTransaction(() => mined++),
					}),
				},
			} as unknown as RunContext
			const user = new User(context, signer(userAddress))
			user.getBalanceInfo = async () => {
				diagnosticReads++
				return {} as Awaited<ReturnType<User["getBalanceInfo"]>>
			}
			user.getUpnl = async () => {
				diagnosticReads++
				return 0n
			}

			await user.requestToCancelQuote(1n)

			expect(diagnosticReads).to.equal(0)
			expect(mined).to.equal(1)
		})

		it("does not read Hedger or User diagnostics when detailed logging is disabled", async function () {
			let diagnosticReads = 0
			let mined = 0
			logger.isLevelEnabled = () => false
			const user = {
				getBalanceInfo: async () => {
					diagnosticReads++
					return {}
				},
				getUpnl: async () => {
					diagnosticReads++
					return 0n
				},
			}
			const context = {
				viewFacetQuote: {
					getQuote: async () => ({ partyA: userAddress }),
				},
				manager: {
					getUser: () => user,
				},
				partyBPositionActionsFacet: {
					connect: () => ({
						openPosition: () => minedTransaction(() => mined++),
					}),
				},
			} as unknown as RunContext
			const hedger = new Hedger(context, signer(hedgerAddress))
			hedger.getBalanceInfo = async () => {
				diagnosticReads++
				return {} as Awaited<ReturnType<Hedger["getBalanceInfo"]>>
			}
			hedger.getUpnl = async () => {
				diagnosticReads++
				return 0n
			}

			await hedger.openPosition(1n)

			expect(diagnosticReads).to.equal(0)
			expect(mined).to.equal(1)
		})

		it("still resolves and emits detailed diagnostics when enabled", async function () {
			let diagnosticReads = 0
			const messages: unknown[] = []
			logger.isLevelEnabled = () => true
			logger.detailedDebug = (message: unknown) => messages.push(message)
			const context = {
				partyAFacet: {
					connect: () => ({
						requestToCancelQuote: () => minedTransaction(),
					}),
				},
			} as unknown as RunContext
			const user = new User(context, signer(userAddress))
			user.getBalanceInfo = async () => {
				diagnosticReads++
				return {} as Awaited<ReturnType<User["getBalanceInfo"]>>
			}
			user.getUpnl = async () => {
				diagnosticReads++
				return 7n
			}

			await user.requestToCancelQuote(9n)

			expect(diagnosticReads).to.equal(2)
			expect(messages).to.have.length(1)
			expect(messages[0]).to.deep.equal({
				request: "RequestToCancelQuote",
				userBalanceInfo: {},
				userUpnl: 7n,
			})
		})

		it("does not let enabled diagnostics advance the modeled random sequence", async function () {
			setRandomSeed("legacy-log-isolation")
			const expectedNextValue = randomBigNumber(10_000n)

			setRandomSeed("legacy-log-isolation")
			await logDetailedDebug(() => ({ sampledDiagnostic: randomBigNumber(10_000n) }), {
				isLevelEnabled: () => true,
				detailedDebug: () => undefined,
			})

			expect(randomBigNumber(10_000n)).to.equal(expectedNextValue)
		})
	})
}
