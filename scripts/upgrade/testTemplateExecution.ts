/**
 * End-to-end test: execute an InstantLayer template after upgrade.
 *
 * Runs against a local or fork node where the v0.8.5 upgrade has already been
 * applied (via eoaUpgrade.ts or forkUpgrade.ts). Sets up the full environment
 * needed to execute an InstantOpen template: SymmioPartyB, affiliate, virtual
 * account, funding, delegation, and EIP-712 signed operations.
 *
 * Supports two modes:
 *   - Local (default): uses signers[0] as admin, mints collateral via FakeStablecoin
 *   - Fork (FORK=true): impersonates diamond owner, sets ERC20 balances via storage manipulation
 *
 * Prerequisites:
 *   - Hardhat node running with v0.8.5 upgrade applied
 *   - AccountLayer + InstantLayer deployed and wired
 *
 * Usage (local):
 *   npx hardhat run scripts/upgrade/testTemplateExecution.ts --network docker
 *
 * Usage (fork, after forkUpgrade.ts):
 *   FORK=true npx hardhat run scripts/upgrade/testTemplateExecution.ts --network fork-arbitrum
 *
 * Auto-loads from upgrade-{network}.json + output files (deployed-accountlayer-instantlayer.json
 * or deployed-peripherals.json). Env vars and testTemplateExecution.json override.
 */
import fs from "fs"

import connection, { ethers, networkHelpers } from "../../test/helpers/hardhat-connection.js"
import { resolveOwner, impersonateAndFund } from "./utils/forkHelpers.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"

// ============================================================================
// Config
// ============================================================================

type Config = {
	diamondAddress?: string
	accountLayerDiamondAddress?: string
	instantLayerAddress?: string
	collateralAddress?: string
	fork?: boolean
	symmioPartyBAddress?: string
}

const CONFIG_FILE = process.env.TEST_TEMPLATE_CONFIG ?? "./scripts/upgrade/config/testTemplateExecution.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config

	// Auto-load from upgrade config + output files (no manual config needed)
	const config: Config = {}

	// Read diamondAddress and symmioPartyBAddress from upgrade config
	const upgradeConfigFile = resolveConfigFile("upgrade", connection.networkName, process.env.UPGRADE_CONFIG_FILE)
	if (fs.existsSync(upgradeConfigFile)) {
		const upgrade = JSON.parse(fs.readFileSync(upgradeConfigFile, "utf-8"))
		config.diamondAddress = upgrade.diamondAddress
		config.symmioPartyBAddress = upgrade.symmioPartyBAddress
		console.log(`Loaded diamond + partyB from ${upgradeConfigFile}`)
	}

	// Read AL + IL from deployed output (forkUpgrade or deployPeripherals)
	const alilFile = `${OUTPUT_DIR}/deployed-accountlayer-instantlayer.json`
	const peripheralsFile = `${OUTPUT_DIR}/deployed-peripherals-${connection.networkName}.json`

	if (fs.existsSync(alilFile)) {
		const alil = JSON.parse(fs.readFileSync(alilFile, "utf-8"))
		config.accountLayerDiamondAddress = alil.accountLayer?.diamond
		config.instantLayerAddress = alil.instantLayer?.address
		console.log(`Loaded AL + IL from ${alilFile}`)
	} else if (fs.existsSync(peripheralsFile)) {
		const peripherals = JSON.parse(fs.readFileSync(peripheralsFile, "utf-8"))
		config.accountLayerDiamondAddress = peripherals.accountLayer?.diamond
		config.instantLayerAddress = peripherals.instantLayer?.address
		console.log(`Loaded AL + IL from ${peripheralsFile}`)
	}

	return config
}

// ============================================================================
// Helpers
// ============================================================================

function decimal(value: bigint, dec: number = 18): bigint {
	return value * 10n ** BigInt(dec)
}

function generateSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

const EIP712_TYPES = {
	Account: [
		{ name: "addr", type: "address" },
		{ name: "isPartyB", type: "bool" },
	],
	ReplayAttackHeader: [
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	],
	FlexField: [
		{ name: "offset", type: "uint256" },
		{ name: "length", type: "uint256" },
		{ name: "authorizedFlexFiller", type: "address" },
	],
	SignedOperation: [
		{ name: "signer", type: "address" },
		{ name: "target", type: "address" },
		{ name: "callData", type: "bytes" },
		{ name: "signerAccount", type: "Account" },
		{ name: "flexFields", type: "FlexField[]" },
		{ name: "maxUses", type: "uint256" },
		{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
	],
}

async function getBlockTimestamp(additional: bigint = 0n): Promise<bigint> {
	const block = await ethers.provider.getBlock("latest")
	return BigInt(block!.timestamp) + 1n + additional
}

async function getDummySingleUpnlSig(upnl: bigint = 0n) {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(700n),
		upnl,
		gatewaySignature: ethers.ZeroAddress,
		sigs: { signature: "0", owner: ethers.ZeroAddress, nonce: ethers.ZeroAddress },
	}
}

async function getDummySingleUpnlAndPriceSig(price: bigint = 1n, upnl: bigint = 0n) {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(700n),
		upnl,
		gatewaySignature: ethers.ZeroAddress,
		sigs: { signature: "0", owner: ethers.ZeroAddress, nonce: ethers.ZeroAddress },
		price,
	}
}

async function getDummyPairUpnlAndPriceSig(price: bigint = 1n, upnlPartyA: bigint = 0n, upnlPartyB: bigint = 0n) {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(),
		upnlPartyA,
		upnlPartyB,
		gatewaySignature: ethers.ZeroAddress,
		sigs: { signature: "0", owner: ethers.ZeroAddress, nonce: ethers.ZeroAddress },
		price,
	}
}

/**
 * Set ERC20 balance for an address by brute-forcing the storage slot.
 * Tries common balanceOf mapping slots (0-10) used by OZ and other implementations.
 */
async function setERC20Balance(token: string, account: string, amount: bigint): Promise<void> {
	const iface = new ethers.Interface(["function balanceOf(address) view returns (uint256)"])
	const tokenContract = new ethers.Contract(token, iface, ethers.provider)

	for (let slot = 0; slot <= 10; slot++) {
		// balanceOf mapping: keccak256(abi.encode(account, slot))
		const storageSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, slot]))
		const value = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount])

		await ethers.provider.send("hardhat_setStorageAt", [token, storageSlot, value])

		// Check if it worked
		const balance = await tokenContract.balanceOf(account)
		if (balance === amount) return
		// Reset if wrong slot
		await ethers.provider.send("hardhat_setStorageAt", [token, storageSlot, ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0n])])
	}
	throw new Error(`Failed to set ERC20 balance for ${account} on ${token} -- could not find balanceOf storage slot`)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const config = loadConfig()

	const DIAMOND = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const AL_ADDRESS = process.env.ACCOUNT_LAYER_ADDRESS ?? config.accountLayerDiamondAddress
	const IL_ADDRESS = process.env.INSTANT_LAYER_ADDRESS ?? config.instantLayerAddress
	const COLLATERAL = process.env.COLLATERAL_ADDRESS ?? config.collateralAddress
	const isFork = (process.env.FORK ?? String(config.fork ?? "")).toLowerCase() === "true"
	const EXISTING_PARTYB = process.env.SYMMIO_PARTYB_ADDRESS ?? config.symmioPartyBAddress

	if (!DIAMOND) throw new Error("DIAMOND_ADDRESS required")
	if (!AL_ADDRESS) throw new Error("ACCOUNT_LAYER_ADDRESS required")
	if (!IL_ADDRESS) throw new Error("INSTANT_LAYER_ADDRESS required")

	console.log(`Mode:          ${isFork ? "FORK" : "LOCAL"}`)
	console.log(`Diamond:       ${DIAMOND}`)
	console.log(`AccountLayer:  ${AL_ADDRESS}`)
	console.log(`InstantLayer:  ${IL_ADDRESS}`)

	const roleHash = (name: string) => ethers.id(name)

	// =========================================================================
	// Resolve admin and test signers
	// =========================================================================
	let admin: any
	let partyASigner: any
	let partyBSigner: any

	// delegateSigner: a hardhat account with a real private key for EIP-712 signing (used in delegation)
	let delegateSigner: any

	if (isFork) {
		// Impersonate the real diamond owner
		const ownerAddress = await resolveOwner(DIAMOND)
		admin = await impersonateAndFund(ownerAddress)

		// Use hardhat accounts as partyA/partyB/delegate signers (they have signing keys)
		const signers = await ethers.getSigners()
		partyASigner = signers[1]
		partyBSigner = signers[2]
		delegateSigner = signers[3]
		await networkHelpers.setBalance(await partyASigner.getAddress(), ethers.parseEther("100"))
		await networkHelpers.setBalance(await partyBSigner.getAddress(), ethers.parseEther("100"))
		await networkHelpers.setBalance(await delegateSigner.getAddress(), ethers.parseEther("100"))
	} else {
		const signers = await ethers.getSigners()
		admin = signers[0]
		partyASigner = signers[1]
		partyBSigner = signers[2]
		delegateSigner = signers[0] // In local mode, admin has a real key
	}

	const adminAddress = await admin.getAddress()
	const partyAAddress = await partyASigner.getAddress()
	const partyBSignerAddress = await partyBSigner.getAddress()
	const delegateAddress = await delegateSigner.getAddress()

	console.log(`Admin:         ${adminAddress}`)
	console.log(`PartyA:        ${partyAAddress}`)
	console.log(`PartyB signer: ${partyBSignerAddress}`)
	console.log(`Delegate:      ${delegateAddress}`)
	console.log()

	// Connect to contracts
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND, admin)
	const symbolControlFacet = await ethers.getContractAt(
		"contracts/core/facets/SymbolControl/SymbolControlFacet.sol:SymbolControlFacet",
		DIAMOND,
		admin,
	)
	const pauseControlFacet = await ethers.getContractAt("contracts/core/facets/PauseControl/PauseControlFacet.sol:PauseControlFacet", DIAMOND, admin)
	const partyAFacet = await ethers.getContractAt("contracts/core/facets/PartyA/PartyAFacet.sol:PartyAFacet", DIAMOND, admin)
	const partyBQuoteActionsFacet = await ethers.getContractAt(
		"contracts/core/facets/PartyBQuoteActions/PartyBQuoteActionsFacet.sol:PartyBQuoteActionsFacet",
		DIAMOND,
		admin,
	)
	const partyBPositionActionsFacet = await ethers.getContractAt(
		"contracts/core/facets/PartyBPositionActions/PartyBPositionActionsFacet.sol:PartyBPositionActionsFacet",
		DIAMOND,
		admin,
	)
	const bindingFacet = await ethers.getContractAt("contracts/core/facets/Binding/BindingFacet.sol:BindingFacet", DIAMOND, admin)
	const accountFacet = await ethers.getContractAt("contracts/core/facets/Account/AccountFacet.sol:AccountFacet", DIAMOND, admin)
	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", DIAMOND, admin)
	const alAffiliateFacet = await ethers.getContractAt("contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet", AL_ADDRESS, admin)
	const instantLayer = await ethers.getContractAt("InstantLayer", IL_ADDRESS, admin)

	// =========================================================================
	// Step 1: Setup SymmioPartyB
	// =========================================================================
	console.log("=== Step 1: Setup SymmioPartyB ===")
	let symmioPartyBAddress: string
	let symmioPartyB: any

	if (isFork && EXISTING_PARTYB) {
		// Upgrade existing proxy to v0.8.5 implementation (adds ERC-1271)
		symmioPartyBAddress = EXISTING_PARTYB
		console.log(`  Using existing PartyB proxy: ${symmioPartyBAddress}`)

		const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
		const newImpl = await SymmioPartyBFactory.deploy()
		await newImpl.waitForDeployment()
		const newImplAddress = await newImpl.getAddress()
		console.log(`  New implementation deployed: ${newImplAddress}`)

		// UUPS: call upgradeTo on the proxy directly
		const proxyContract = new ethers.Contract(symmioPartyBAddress, ["function upgradeTo(address newImplementation)"], admin)
		await (await proxyContract.upgradeTo(newImplAddress)).wait()
		console.log(`  Proxy upgraded via UUPS`)

		symmioPartyB = await ethers.getContractAt("SymmioPartyB", symmioPartyBAddress, admin)

		// Ensure PartyB is bindable (new v0.8.5 mapping, defaults to false for existing PartyBs)
		await (await controlFacet.grantRole(adminAddress, roleHash("PARTY_B_MANAGER_ROLE"))).wait()
		await (await controlFacet.setPartyBBindable(symmioPartyBAddress, true)).wait()
		console.log("  Set bindable")

		// Register on InstantLayer if not already registered
		const isRegistered = await instantLayer.registeredPartyBs(symmioPartyBAddress)
		if (!isRegistered) {
			await (await instantLayer.registerPartyBs([symmioPartyBAddress])).wait()
			console.log("  Registered on InstantLayer")
		} else {
			console.log("  Already registered on InstantLayer")
		}
	} else {
		// Fresh deploy (local mode)
		const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
		const symmioPartyBImpl = await SymmioPartyBFactory.deploy()
		await symmioPartyBImpl.waitForDeployment()

		const ERC1967ProxyFactory = await ethers.getContractFactory("LocalERC1967Proxy")
		const initData = SymmioPartyBFactory.interface.encodeFunctionData("initialize", [adminAddress, DIAMOND])
		const proxy = await ERC1967ProxyFactory.deploy(await symmioPartyBImpl.getAddress(), initData)
		await proxy.waitForDeployment()
		symmioPartyBAddress = await proxy.getAddress()
		symmioPartyB = await ethers.getContractAt("SymmioPartyB", symmioPartyBAddress, admin)
		console.log(`  SymmioPartyB deployed: ${symmioPartyBAddress}`)

		// Register on core diamond
		await (await controlFacet.grantRole(adminAddress, roleHash("PARTY_B_MANAGER_ROLE"))).wait()
		await (await controlFacet.registerPartyB(symmioPartyBAddress)).wait()
		await (await controlFacet.setPartyBBindable(symmioPartyBAddress, true)).wait()
		console.log("  Registered on Diamond and set bindable")

		// Register on InstantLayer
		await (await instantLayer.registerPartyBs([symmioPartyBAddress])).wait()
		console.log("  Registered on InstantLayer (OPERATOR_ROLE granted)")
	}

	// Set ERC-1271 signer
	try {
		await (await symmioPartyB.grantRole(roleHash("SETTER_ROLE"), adminAddress)).wait()
	} catch {
		// Role may already be granted
	}
	await (await symmioPartyB.setSigner(partyBSignerAddress)).wait()
	console.log(`  Signer set to ${partyBSignerAddress}`)

	// =========================================================================
	// Step 2: Register affiliate on AccountLayer
	// =========================================================================
	console.log("\n=== Step 2: Register affiliate on AccountLayer ===")

	const MockMultiAccount = await ethers.getContractFactory("MockMultiAccount")
	const mockMultiAccount = await MockMultiAccount.deploy(DIAMOND)
	await mockMultiAccount.waitForDeployment()

	const affiliateData = {
		name: "test-affiliate",
		brandColor: "d69d00",
		admin: adminAddress,
		stakeholders: [{ receiver: adminAddress, share: decimal(9n, 17) }],
		symmioShare: decimal(1n, 17),
		metadata: "0x",
		legacyMultiAccounts: [await mockMultiAccount.getAddress()],
		symmioCores: [DIAMOND],
	}

	const affiliateAddress = await alAffiliateFacet.requestToRegisterAffiliate.staticCall(affiliateData)
	await (await alAffiliateFacet.requestToRegisterAffiliate(affiliateData)).wait()
	await (await alAffiliateFacet.approveAffiliate(affiliateAddress)).wait()
	console.log(`  Affiliate: ${affiliateAddress}`)

	const accountManager = await ethers.getContractAt("contracts/accountLayer/AccountManager.sol:AccountManager", affiliateAddress, partyASigner)

	// =========================================================================
	// Step 3: Unpause system
	// =========================================================================
	console.log("\n=== Step 3: Unpause system ===")
	await (await controlFacet.grantRole(adminAddress, roleHash("UNPAUSER_ROLE"))).wait()
	const unpauseFns = ["unpauseGlobal", "unpauseAccounting", "unpausePartyAActions", "unpausePartyBActions"] as const
	for (const fn of unpauseFns) {
		try {
			await (await pauseControlFacet[fn]()).wait()
			console.log(`  ${fn}()`)
		} catch {
			// Already unpaused
		}
	}
	console.log("  System unpaused")

	// =========================================================================
	// Step 4: Create virtual account + bind to PartyB
	// =========================================================================
	console.log("\n=== Step 4: Create virtual account and bind ===")
	await (await accountManager.addAccount("test-account")).wait()
	const accounts = await accountManager.getAccounts(partyAAddress, 0, 100)
	const subAccountAddress = accounts[0].accountAddress
	console.log(`  Sub-account: ${subAccountAddress}`)

	const bindCallData = bindingFacet.interface.encodeFunctionData("bindToPartyB", [symmioPartyBAddress])
	await (await accountManager._call(subAccountAddress, [bindCallData])).wait()
	console.log("  Bound to PartyB")

	// =========================================================================
	// Step 5: Fund accounts + whitelist symbol
	// =========================================================================
	console.log("\n=== Step 5: Fund accounts + whitelist symbol ===")

	// Resolve collateral address
	let collateralAddress = COLLATERAL
	if (!collateralAddress) {
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND, admin)
		collateralAddress = await viewFacet.getCollateral()
	}
	console.log(`  Collateral: ${collateralAddress}`)

	// Read collateral decimals for correct amounts
	const collateralMeta = new ethers.Contract(collateralAddress, ["function decimals() view returns (uint8)"], ethers.provider)
	const collateralDecimals = Number(await collateralMeta.decimals())
	const col = (n: bigint) => decimal(n, collateralDecimals)
	console.log(`  Decimals: ${collateralDecimals}`)

	if (isFork) {
		// Fork mode: set ERC20 balances directly (no mint function on real tokens)
		await setERC20Balance(collateralAddress, partyAAddress, col(100000n))
		console.log("  PartyA: balance set via storage")

		// Approve + deposit + allocate for PartyA
		const collateralForPartyA = new ethers.Contract(collateralAddress, ["function approve(address,uint256) returns (bool)"], partyASigner)
		await (await collateralForPartyA.approve(DIAMOND, ethers.MaxUint256)).wait()
		await (await accountFacet.connect(partyASigner).depositAndAllocateFor(subAccountAddress, col(10000n))).wait()
		console.log("  PartyA: deposited and allocated 10000")

		// Fund PartyB
		await setERC20Balance(collateralAddress, symmioPartyBAddress, col(100000n))
		console.log("  PartyB: balance set via storage")

		try {
			await (await symmioPartyB.grantRole(roleHash("TRUSTED_ROLE"), adminAddress)).wait()
			console.log("  PartyB: TRUSTED_ROLE granted to admin")
		} catch (e: any) {
			console.log(`  PartyB: grantRole(TRUSTED_ROLE) failed: ${e.shortMessage ?? e.message?.slice(0, 150)}`)
		}
		try {
			await (await symmioPartyB._approve(collateralAddress, col(100000n))).wait()
		} catch (e: any) {
			console.log(`  PartyB: _approve failed: ${e.shortMessage ?? e.message?.slice(0, 150)}`)
			throw e
		}

		const partyBAccountFacet = await ethers.getContractAt(
			"contracts/core/facets/PartyBAccount/PartyBAccountFacet.sol:PartyBAccountFacet",
			DIAMOND,
			admin,
		)
		const depositCallData = accountFacet.interface.encodeFunctionData("deposit", [col(50000n)])
		const allocateCallData = partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [col(50000n), subAccountAddress])
		await (await symmioPartyB._call([depositCallData, allocateCallData])).wait()
		console.log("  PartyB: deposited and allocated 50000")
	} else {
		// Local mode: use FakeStablecoin.mint()
		const collateral = await ethers.getContractAt("FakeStablecoin", collateralAddress, partyASigner)

		// Fund PartyA
		await (await collateral.mint(partyAAddress, decimal(100000n))).wait()
		await (await collateral.approve(DIAMOND, ethers.MaxUint256)).wait()
		await (await accountFacet.connect(partyASigner).depositAndAllocateFor(subAccountAddress, decimal(10000n))).wait()
		console.log("  PartyA: deposited and allocated 10000")

		// Fund PartyB
		await (await collateral.connect(admin).mint(symmioPartyBAddress, decimal(100000n))).wait()
		await (await symmioPartyB.grantRole(roleHash("TRUSTED_ROLE"), adminAddress)).wait()
		await (await symmioPartyB._approve(collateralAddress, decimal(100000n))).wait()

		const partyBAccountFacet = await ethers.getContractAt(
			"contracts/core/facets/PartyBAccount/PartyBAccountFacet.sol:PartyBAccountFacet",
			DIAMOND,
			admin,
		)
		const depositCallData = accountFacet.interface.encodeFunctionData("deposit", [decimal(50000n)])
		const allocateCallData = partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [decimal(50000n), subAccountAddress])
		await (await symmioPartyB._call([depositCallData, allocateCallData])).wait()
		console.log("  PartyB: deposited and allocated 50000")
	}

	// Whitelist symbol type
	await (await controlFacet.grantRole(adminAddress, roleHash("SYMBOL_MANAGER_ROLE"))).wait()
	await (await symbolControlFacet.setSymbolTypes([1], [1])).wait()
	await (await symbolControlFacet.whitelistSymbolType(symmioPartyBAddress, 1)).wait()
	console.log("  Symbol type 1 set and whitelisted for PartyB")

	// =========================================================================
	// Step 6: Build calldata for template operations
	// =========================================================================
	console.log("\n=== Step 6: Build template operations ===")

	const quoteCallData = partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
		[symmioPartyBAddress], // partyBWhiteList
		1, // symbolId
		0, // positionType: LONG
		1, // orderType: LIMIT
		decimal(1n), // price
		decimal(100n), // quantity
		decimal(22n), // cva
		decimal(3n), // lf
		decimal(75n), // partyAmm
		decimal(40n), // partyBmm
		decimal(2n, 16), // maxFundingRate
		await getBlockTimestamp(500n), // deadline
		affiliateAddress, // affiliate
		await getDummySingleUpnlAndPriceSig(decimal(1n)), // upnlSig
	])

	const lockQuoteCallData = partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [0, await getDummySingleUpnlSig(10n)])

	const openQuoteCallData = partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
		0, // quoteId placeholder
		decimal(100n), // filledAmount
		decimal(1n), // openedPrice
		await getDummyPairUpnlAndPriceSig(10n),
	])

	// Template: 4 ops - sendQuote, sendQuote, lockQuote(inject from op0), openPosition(inject from op0)
	const templateOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
		{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [0] },
		{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [0] },
	]

	await (await instantLayer.addTemplate("TestInstantOpen", templateOps)).wait()
	const templateId = (await instantLayer.getNextTemplateId()) - 1n
	console.log(`  Template "TestInstantOpen" added (id: ${templateId})`)

	// =========================================================================
	// Step 7: Setup delegation
	// =========================================================================
	console.log("\n=== Step 7: Setup delegation ===")
	const selectorQuote = quoteCallData.slice(0, 10) as string
	const deadline = await getBlockTimestamp(500n)

	await (
		await instantLayer.connect(partyASigner).grantDelegation({
			account: { addr: subAccountAddress, isPartyB: false },
			delegatedSigner: delegateAddress,
			selectors: [selectorQuote],
			expiryTimestamp: await getBlockTimestamp(1000n),
		})
	).wait()
	console.log(`  Delegation granted: ${delegateAddress} can sendQuote on behalf of partyA`)

	// =========================================================================
	// Step 8: Execute template
	// =========================================================================
	console.log("\n=== Step 8: Execute template ===")

	// Get quoteId offset for fork (existing quotes on-chain)
	const nextQuoteId = isFork ? await viewFacetQuote.getNextQuoteId() : 1n

	const domain = {
		name: "SymmioInstantLayer",
		version: "1",
		chainId: Number((await ethers.provider.getNetwork()).chainId),
		verifyingContract: IL_ADDRESS,
	}

	// Op 1: PartyA sends quote (via delegated signer)
	const op1 = {
		signer: delegateAddress,
		target: DIAMOND,
		callData: quoteCallData,
		signerAccount: { addr: subAccountAddress, isPartyB: false },
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 1n, deadline, salt: generateSalt() },
	}

	// Op 2: PartyA sends second quote (via account owner directly)
	const op2 = {
		signer: partyAAddress,
		target: DIAMOND,
		callData: quoteCallData,
		signerAccount: { addr: subAccountAddress, isPartyB: false },
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 2n, deadline, salt: generateSalt() },
	}

	// Op 3: PartyB locks first quote (quoteId injected from op0)
	const op3 = {
		signer: symmioPartyBAddress,
		target: DIAMOND,
		callData: lockQuoteCallData,
		signerAccount: { addr: symmioPartyBAddress, isPartyB: true },
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 1n, deadline, salt: generateSalt() },
	}

	// Op 4: PartyB opens first quote (quoteId injected from op0)
	const op4 = {
		signer: symmioPartyBAddress,
		target: DIAMOND,
		callData: openQuoteCallData,
		signerAccount: { addr: symmioPartyBAddress, isPartyB: true },
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 2n, deadline, salt: generateSalt() },
	}

	// Sign operations
	const sig1 = await delegateSigner.signTypedData(domain, EIP712_TYPES, op1)
	const sig2 = await partyASigner.signTypedData(domain, EIP712_TYPES, op2)
	const sig3 = await partyBSigner.signTypedData(domain, EIP712_TYPES, op3)
	const sig4 = await partyBSigner.signTypedData(domain, EIP712_TYPES, op4)

	// Execute template
	const tx = await instantLayer
		.connect(admin)
		.executeTemplate(templateId, [op1, op2, op3, op4], [sig1, sig2, sig3, sig4], [[], [], [], []], [[], [], [], []])
	const receipt = await tx.wait()
	console.log(`  Template executed (tx: ${receipt?.hash})`)

	// =========================================================================
	// Step 9: Verify results
	// =========================================================================
	console.log("\n=== Step 9: Verify results ===")
	const postNextQuoteId = await viewFacetQuote.getNextQuoteId()
	const newQuoteCount = Number(postNextQuoteId - nextQuoteId)
	console.log(`  New quotes created: ${newQuoteCount} (IDs ${nextQuoteId} to ${postNextQuoteId - 1n})`)

	const OPENED = 4
	const PENDING = 0
	let openedCount = 0
	let pendingCount = 0

	for (let id = nextQuoteId; id < postNextQuoteId; id++) {
		const q = await viewFacetQuote.getQuote(id)
		const status = Number(q.quoteStatus)
		const statusName = status === OPENED ? "OPENED" : status === PENDING ? "PENDING" : `UNKNOWN(${status})`
		const isOurs = q.partyA.toLowerCase() === subAccountAddress.toLowerCase()
		console.log(`  Quote ${id}: status=${statusName} partyA=${q.partyA}${isOurs ? " (our sub-account)" : ""}`)
		if (isOurs && status === OPENED) openedCount++
		if (isOurs && status === PENDING) pendingCount++
	}

	if (openedCount >= 1 && newQuoteCount >= 2) {
		console.log(`\n  [PASS] Template execution verified successfully!`)
		console.log(`    - ${openedCount} quote(s) OPENED via template (sendQuote -> lockQuote -> openPosition)`)
		console.log(`    - ${pendingCount} quote(s) PENDING (sent only)`)
		console.log(`    - ${newQuoteCount} total new quotes created`)
	} else {
		console.log(`\n  [FAIL] Expected at least 1 OPENED quote and 2 new quotes, got ${openedCount} opened, ${newQuoteCount} new`)
		process.exitCode = 1
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
