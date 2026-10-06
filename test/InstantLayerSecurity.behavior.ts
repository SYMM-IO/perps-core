import { expect } from "chai"
import { toUtf8Bytes, TypedDataDomain } from "ethers"

import type { InstantLayer } from "../src/types/index.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { cloneTypes } from "./helpers/instantLayerEIP712Types.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { Hedger } from "./models/Hedger.js"
import { User } from "./models/User.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const ROLES = {
	SETTER_ROLE: ethers.keccak256(toUtf8Bytes("SETTER_ROLE")),
	OPERATOR_ROLE: ethers.keccak256(toUtf8Bytes("OPERATOR_ROLE")),
	INSTANT_LAYER_ROLE: ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")),
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

async function createDomain(instantLayerAddress: string): Promise<TypedDataDomain> {
	return {
		name: "SymmioInstantLayer",
		version: "1",
		chainId: (await ethers.provider.getNetwork()).chainId,
		verifyingContract: instantLayerAddress,
	}
}

function generateSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

function createSignedOperation(
	signer: string,
	target: string,
	callData: string,
	signerAccount: InstantLayer.AccountStruct,
	nonce: bigint,
	deadline: bigint,
): InstantLayer.SignedOperationStruct {
	return {
		signer,
		target,
		callData,
		signerAccount,
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce, deadline, salt: generateSalt() },
	}
}

async function signOperation(
	signer: any,
	domain: TypedDataDomain,
	types: ReturnType<typeof cloneTypes>,
	op: InstantLayer.SignedOperationStruct,
): Promise<string> {
	return signer.signTypedData(domain, types, op)
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════

export function shouldBehaveLikeInstantLayerSecurity(): void {
	it("should block attacker from operating on victim's account via direct accountLayer target", async function () {
		// 1. SETUP
		const context = await loadFixture(initializeFixture)

		const victim = new User(context, context.signers.user)
		const alice = new User(context, context.signers.user2)
		const hedger = new Hedger(context, context.signers.hedger)

		await Promise.all([victim.setup(), alice.setup(), hedger.setup()])

		await victim.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))
		await alice.setBalances(decimal(100000n), decimal(5000n))

		// Grant INSTANT_LAYER_ROLE on Diamond (for setCallFromInstantLayer)
		await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)

		await context.controlFacet.connect(context.signers.admin).registerPartyB(await context.symmioPartyB.getAddress())
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(await context.symmioPartyB.getAddress(), true)

		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
		await context.instantLayer.registerPartyBs([await context.symmioPartyB.getAddress()])

		// 2. VICTIM: Create account with funds
		await context.accountManager.connect(victim.signer).addAccount("victimAccount")
		const victimAccounts = await context.accountManager.getAccounts(victim.address, 0, 100)
		const victimAccount = victimAccounts[0].accountAddress

		const depositAmountCollateral = 1000n * 10n ** BigInt(await context.collateral.decimals())
		await context.collateral.connect(victim.signer).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(victim.signer).depositFor(victimAccount, depositAmountCollateral)

		// 3. ATTACKER: Create alice's account
		await context.accountManager.connect(alice.signer).addAccount("aliceAccount")
		const aliceAccounts = await context.accountManager.getAccounts(alice.address, 0, 100)
		const aliceAccount = aliceAccounts[0].accountAddress

		// 4. RECORD BALANCES BEFORE ATTACK
		const victimBalanceBefore = await context.viewFacet.balanceOf(victimAccount)
		expect(victimBalanceBefore).to.be.gt(0n)

		// 5. CONSTRUCT ATTACK
		const accountLayerAddress = context.accountLayerDiamond
		const deadline = await getBlockTimestamp(300n)

		// Encode withdrawTo(alice.address, amount) as inner call
		const withdrawToCallData = context.accountFacet.interface.encodeFunctionData("withdrawTo", [alice.address, depositAmountCollateral])

		// Encode _call(victimAccount, [withdrawToCallData]) — targets the VICTIM's account
		const maliciousCallData = context.alCoreFacet.interface.encodeFunctionData("_call", [victimAccount, [withdrawToCallData]])

		// signerAccount = aliceAccount (passes ownership check), but callData targets victimAccount
		const attackOp = createSignedOperation(
			alice.address,
			accountLayerAddress,
			maliciousCallData,
			{ addr: aliceAccount, isPartyB: false },
			1n,
			deadline,
		)

		const domain = await createDomain(await context.instantLayer.getAddress())
		const types = cloneTypes()
		const sig = await signOperation(alice.signer, domain, types, attackOp)

		// 6. EXECUTE ATTACK — should REVERT because setSigner sets alice's EOA,
		//    and onlyAccountOwner(victimAccount) checks ownership against alice's EOA → fails
		await expect(context.instantLayer.executeBatch([attackOp], [sig], [[]], [[]])).to.be.reverted

		// 7. VERIFY: Victim's funds are intact
		const victimBalanceAfter = await context.viewFacet.balanceOf(victimAccount)
		expect(victimBalanceAfter).to.equal(victimBalanceBefore)
	})

	it("should allow legitimate accountLayer calls through InstantLayer", async function () {
		// 1. SETUP
		const context = await loadFixture(initializeFixture)

		const user = new User(context, context.signers.user)
		const hedger = new Hedger(context, context.signers.hedger)

		await Promise.all([user.setup(), hedger.setup()])
		await user.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))

		await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
		await context.controlFacet.connect(context.signers.admin).registerPartyB(await context.symmioPartyB.getAddress())
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(await context.symmioPartyB.getAddress(), true)

		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
		await context.instantLayer.registerPartyBs([await context.symmioPartyB.getAddress()])

		// 2. USER: Create account with funds
		await context.accountManager.connect(user.signer).addAccount("myAccount")
		const accounts = await context.accountManager.getAccounts(user.address, 0, 100)
		const userAccount = accounts[0].accountAddress

		const depositAmountCollateral = 500n * 10n ** BigInt(await context.collateral.decimals())
		await context.collateral.connect(user.signer).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user.signer).depositFor(userAccount, depositAmountCollateral)

		const balanceBefore = await context.viewFacet.balanceOf(userAccount)
		expect(balanceBefore).to.be.gt(0n)

		// 3. CONSTRUCT LEGITIMATE OPERATION: user targets their own account
		const accountLayerAddress = context.accountLayerDiamond
		const deadline = await getBlockTimestamp(300n)

		// Encode withdrawTo(user.address, smallAmount) as inner call
		const smallWithdrawAmount = 100n * 10n ** BigInt(await context.collateral.decimals())
		const withdrawToCallData = context.accountFacet.interface.encodeFunctionData("withdrawTo", [user.address, smallWithdrawAmount])

		// Encode _call(userAccount, [withdrawToCallData]) — targets user's OWN account
		const callData = context.alCoreFacet.interface.encodeFunctionData("_call", [userAccount, [withdrawToCallData]])

		const op = createSignedOperation(user.address, accountLayerAddress, callData, { addr: userAccount, isPartyB: false }, 1n, deadline)

		const domain = await createDomain(await context.instantLayer.getAddress())
		const types = cloneTypes()
		const sig = await signOperation(user.signer, domain, types, op)

		// 4. EXECUTE — should succeed because setSigner sets user's EOA,
		//    and onlyAccountOwner(userAccount) verifies user owns userAccount
		await context.instantLayer.executeBatch([op], [sig], [[]], [[]])

		// 5. VERIFY: Balance decreased
		const balanceAfter = await context.viewFacet.balanceOf(userAccount)
		expect(balanceAfter).to.be.lt(balanceBefore)
	})
}
