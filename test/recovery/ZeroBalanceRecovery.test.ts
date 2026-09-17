import { expect } from "chai"
import hre from "hardhat"

const { ethers, networkHelpers } = await hre.network.getOrCreate()
const coder = ethers.AbiCoder.defaultAbiCoder()
const globalSlot = BigInt(ethers.id("diamond.standard.storage.global"))
const balanceSlot = (address: string) =>
	ethers.keccak256(coder.encode(["address", "bytes32"], [address, ethers.id("diamond.standard.storage.account")]))
const roleSlot = (address: string) =>
	ethers.keccak256(
		coder.encode(
			["bytes32", "bytes32"],
			[ethers.id("SUSPENDED_FUNDS_WITHDRAWER_ROLE"), ethers.keccak256(coder.encode(["address", "uint256"], [address, globalSlot + 4n]))],
		),
	)

// Independently address the original v0.8.5 storage slots; no test-only setters in the production facet.
async function fixture() {
	const [operator, recipient, unrelated, attacker] = await ethers.getSigners()
	const facet: any = await (await ethers.getContractFactory("ZeroBalanceRecoveryFacet085")).deploy()
	const target = await facet.getAddress()
	const set = async (slot: string | bigint, value: bigint) => networkHelpers.setStorageAt(target, slot, value)
	const balance = async (address: string) => BigInt(await ethers.provider.getStorage(target, balanceSlot(address)))
	await set(roleSlot(operator.address), 1n)
	await set(balanceSlot(ethers.ZeroAddress), 200981026302519456100n)
	await set(balanceSlot(recipient.address), 4605160364884342n)
	await set(balanceSlot(unrelated.address), 777000000000000000001n)
	return { facet, operator, recipient, unrelated, attacker, set, balance }
}

describe("v0.8.5 full-precision zero-address recovery", function () {
	it("sweeps the full balance, records atomic before/after evidence, and writes exactly two slots", async function () {
		const { facet, operator, recipient, unrelated, balance } = await networkHelpers.loadFixture(fixture)
		const amount = await balance(ethers.ZeroAddress),
			before = await balance(recipient.address),
			other = await balance(unrelated.address)
		const tx = await facet.recoverZeroAddressBalance(recipient.address)
		await expect(tx)
			.to.emit(facet, "ZeroAddressBalanceRecovered")
			.withArgs(operator.address, recipient.address, amount, before, before + amount)
		expect(await balance(ethers.ZeroAddress)).to.equal(0n)
		expect(await balance(recipient.address)).to.equal(before + amount)
		expect(await balance(unrelated.address)).to.equal(other)
		const trace = await ethers.provider.send("debug_traceTransaction", [tx.hash, { disableMemory: true, disableStorage: true }])
		const slots = trace.structLogs
			.filter((s: any) => s.op === "SSTORE")
			.map((s: any) => ethers.toBeHex(BigInt(s.stack.at(-1).startsWith("0x") ? s.stack.at(-1) : "0x" + s.stack.at(-1)), 32))
			.sort()
		expect(slots).to.deep.equal([balanceSlot(ethers.ZeroAddress), balanceSlot(recipient.address)].sort())
		await expect(facet.recoverZeroAddressBalance(recipient.address)).to.be.revertedWith("Recovery: Empty balance")
		expect(await balance(recipient.address)).to.equal(before + amount)
	})
	for (const amount of [1n, 999999999999n, 1000000000000n, 1000000000001n]) {
		it(`recovers ${amount} raw units, including sub-collateral dust`, async function () {
			const { facet, recipient, set, balance } = await networkHelpers.loadFixture(fixture)
			await set(balanceSlot(ethers.ZeroAddress), amount)
			const before = await balance(recipient.address)
			await facet.recoverZeroAddressBalance(recipient.address)
			expect(await balance(ethers.ZeroAddress)).to.equal(0n)
			expect(await balance(recipient.address)).to.equal(before + amount)
		})
	}
	it("rejects unauthorized and revoked operators", async function () {
		const { facet, operator, attacker, recipient, set, balance } = await networkHelpers.loadFixture(fixture)
		const before = await balance(ethers.ZeroAddress)
		await expect(facet.connect(attacker).recoverZeroAddressBalance(recipient.address)).to.be.revertedWith("Accessibility: Must have role")
		await set(roleSlot(operator.address), 0n)
		await expect(facet.recoverZeroAddressBalance(recipient.address)).to.be.revertedWith("Accessibility: Must have role")
		expect(await balance(ethers.ZeroAddress)).to.equal(before)
	})
	for (const [offset, reason] of [
		[20, "Global"],
		[22, "Accounting"],
	] as const) {
		it(`respects the ${reason.toLowerCase()} pause`, async function () {
			const { facet, recipient, set, balance } = await networkHelpers.loadFixture(fixture)
			const before = await balance(ethers.ZeroAddress)
			await set(globalSlot + 1n, 1n << BigInt(offset * 8))
			await expect(facet.recoverZeroAddressBalance(recipient.address)).to.be.revertedWith(`Pausable: ${reason} paused`)
			expect(await balance(ethers.ZeroAddress)).to.equal(before)
		})
	}
	it("retains the v0.8.5 persistent proxy-signer guard", async function () {
		const { facet, recipient, attacker, set } = await networkHelpers.loadFixture(fixture)
		await set(globalSlot + 10n, BigInt(attacker.address))
		await expect(facet.recoverZeroAddressBalance(recipient.address)).to.be.revertedWith("Accessibility: Cannot call via proxy")
	})
	it("rejects zero recipients without losing funds", async function () {
		const { facet, balance } = await networkHelpers.loadFixture(fixture)
		const before = await balance(ethers.ZeroAddress)
		await expect(facet.recoverZeroAddressBalance(ethers.ZeroAddress)).to.be.revertedWith("Recovery: Zero recipient")
		expect(await balance(ethers.ZeroAddress)).to.equal(before)
	})
	it("leaves both balances intact if the recipient addition overflows", async function () {
		const { facet, recipient, set, balance } = await networkHelpers.loadFixture(fixture)
		await set(balanceSlot(recipient.address), ethers.MaxUint256)
		const before = await balance(ethers.ZeroAddress)
		await expect(facet.recoverZeroAddressBalance(recipient.address)).to.be.revertedWithPanic(0x11)
		expect(await balance(ethers.ZeroAddress)).to.equal(before)
		expect(await balance(recipient.address)).to.equal(ethers.MaxUint256)
	})
})
