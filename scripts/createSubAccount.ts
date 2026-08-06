import { ethers } from "../test/helpers/hardhat-connection.js"

// Plan a sub-account by default; set EXECUTE=true to broadcast only after review.
// Required: ACCOUNT_LAYER_ADDRESS, AFFILIATE_ADDRESS, SYMMIO_ADDRESS,
// ACCOUNT_NAME, ISOLATION_TYPE, EXPECTED_CHAIN_ID.

function requiredAddress(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address`)
	return ethers.getAddress(value)
}

function requiredChainId(): bigint {
	const value = process.env.EXPECTED_CHAIN_ID
	if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error("EXPECTED_CHAIN_ID must be an explicit positive integer")
	return BigInt(value)
}

function parseBoolean(name: string, fallback: boolean): boolean {
	const value = process.env[name]
	if (value === undefined || value === "") return fallback
	if (value === "true") return true
	if (value === "false") return false
	throw new Error(`${name} must be exactly true or false`)
}

async function requireCode(name: string, address: string): Promise<void> {
	if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${name} has no contract code at ${address}`)
}

async function main(): Promise<void> {
	const accountLayerAddress = requiredAddress("ACCOUNT_LAYER_ADDRESS")
	const affiliateAddress = requiredAddress("AFFILIATE_ADDRESS")
	const symmioCoreAddress = requiredAddress("SYMMIO_ADDRESS")
	const expectedChainId = requiredChainId()
	const accountName = process.env.ACCOUNT_NAME
	if (!accountName || accountName.trim() === "" || accountName !== accountName.trim()) {
		throw new Error("ACCOUNT_NAME must be an explicit, non-empty trimmed string")
	}
	const isolationType = Number(process.env.ISOLATION_TYPE)
	if (!Number.isInteger(isolationType) || isolationType < 0 || isolationType > 3) {
		throw new Error("ISOLATION_TYPE is required and must be one of 0, 1, 2, or 3")
	}
	const singleVAMode = parseBoolean("SINGLE_VA_MODE", false)
	const execute = parseBoolean("EXECUTE", false)
	if (singleVAMode && isolationType !== 1 && isolationType !== 2) {
		throw new Error("SINGLE_VA_MODE=true is only valid for ISOLATION_TYPE=1 (MARKET) or 2 (MARKET_DIRECTION)")
	}
	const metadata = process.env.ACCOUNT_METADATA ?? "0x"
	if (!ethers.isHexString(metadata)) throw new Error("ACCOUNT_METADATA must be a 0x-prefixed hex string")

	const network = await ethers.provider.getNetwork()
	if (network.chainId !== expectedChainId) throw new Error(`Chain mismatch: connected to ${network.chainId}, expected ${expectedChainId}`)
	await requireCode("AccountLayer", accountLayerAddress)
	await requireCode("SYMMIO", symmioCoreAddress)

	const [signer] = await ethers.getSigners()
	if (!signer) throw new Error("No signer is configured for this network")
	const signerAddress = ethers.getAddress(await signer.getAddress())
	const accountLayer = await ethers.getContractAt("contracts/accountLayer/facets/Core/ICoreFacet.sol:ICoreFacet", accountLayerAddress, signer)
	const view = await ethers.getContractAt("contracts/accountLayer/facets/View/IViewFacet.sol:IViewFacet", accountLayerAddress)

	const affiliateState = await view.getAffiliateState(affiliateAddress)
	if (affiliateState !== 2n) throw new Error(`Affiliate ${affiliateAddress} is not ACTIVE (state=${affiliateState})`)
	if (!(await view.isWhitelistedSymmioCore(symmioCoreAddress))) throw new Error(`SYMMIO ${symmioCoreAddress} is not whitelisted on AccountLayer`)
	const affiliateCores: string[] = await view.getAffiliateSymmioCores(affiliateAddress)
	if (!affiliateCores.some(address => ethers.getAddress(address) === symmioCoreAddress)) {
		throw new Error(`SYMMIO ${symmioCoreAddress} is not registered for affiliate ${affiliateAddress}`)
	}

	const subAccountData = {
		name: accountName,
		metadata,
		symmioCore: symmioCoreAddress,
		isolationType,
		singleVAMode,
	}
	const predicted: string[] = await accountLayer.createSubAccounts.staticCall(affiliateAddress, [subAccountData])
	if (predicted.length !== 1 || !ethers.isAddress(predicted[0])) throw new Error("createSubAccounts simulation did not return one valid address")

	console.log("Sub-account creation plan")
	console.log(`  Chain:         ${network.chainId}`)
	console.log(`  Signer/owner:  ${signerAddress}`)
	console.log(`  AccountLayer:  ${accountLayerAddress}`)
	console.log(`  Affiliate:     ${affiliateAddress}`)
	console.log(`  SymmioCore:    ${symmioCoreAddress}`)
	console.log(`  Name:          ${accountName}`)
	console.log(`  IsolationType: ${isolationType}`)
	console.log(`  SingleVAMode:  ${singleVAMode}`)
	console.log(`  Predicted:     ${predicted[0]}`)

	if (!execute) {
		console.log("\nPLAN ONLY: no transaction sent. Set EXECUTE=true after reviewing the plan.")
		return
	}

	const tx = await accountLayer.createSubAccounts(affiliateAddress, [subAccountData])
	console.log(`Transaction: ${tx.hash} (nonce ${tx.nonce})`)
	const receipt = await tx.wait()
	if (!receipt?.status) throw new Error(`createSubAccounts transaction ${tx.hash} failed`)
	const createdEvents = receipt.logs.flatMap((logEntry: any) => {
		try {
			const parsed = accountLayer.interface.parseLog(logEntry)
			return parsed?.name === "SubAccountCreated" ? [parsed] : []
		} catch {
			return []
		}
	})
	if (createdEvents.length !== 1) throw new Error(`Expected one SubAccountCreated event, received ${createdEvents.length}`)
	const createdAddress = ethers.getAddress(createdEvents[0].args.account)
	if (createdAddress !== ethers.getAddress(predicted[0])) {
		console.warn(`Predicted address changed before mining: simulated ${predicted[0]}, emitted ${createdAddress}`)
	}

	const created = await view.getSubAccount(createdAddress)
	if (
		!created.isExists ||
		ethers.getAddress(created.owner) !== signerAddress ||
		ethers.getAddress(created.affiliate) !== affiliateAddress ||
		ethers.getAddress(created.symmioCore) !== symmioCoreAddress ||
		created.name !== accountName ||
		created.isolationType !== BigInt(isolationType) ||
		created.singleVAMode !== singleVAMode ||
		created.metadata.toLowerCase() !== metadata.toLowerCase()
	) {
		throw new Error(`Post-state verification failed for sub-account ${createdAddress}`)
	}
	console.log(`Created and verified ${createdAddress} in block ${receipt.blockNumber}; gas ${receipt.gasUsed}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
