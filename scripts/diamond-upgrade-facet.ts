import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { ethers, hre } from "../test/helpers/hardhat-connection.js"
import { requireExecutionConfirmation } from "./upgrade/utils/executionGuard.js"
import { DIAMOND_OWNER_ABI, readDiamondOwner } from "./upgrade/utils/ownership.js"

// Plan-only by default. Required env:
//   DIAMOND, FACET, FACET_ADDR, CUT_MODE=(add|replace|both)
// Set EXECUTE=true CONFIRM_CHAIN_ID=<connected chain id> only after reviewing the exact selector plan.

function requiredAddress(name: string): string {
	const value = process.env[name]
	if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be an explicit non-zero address`)
	return ethers.getAddress(value)
}

async function requireCode(name: string, address: string): Promise<string> {
	const code = await ethers.provider.getCode(address)
	if (code === "0x") throw new Error(`${name} has no contract code at ${address}`)
	return code
}

async function main(): Promise<void> {
	const diamondAddress = requiredAddress("DIAMOND")
	const newFacetAddress = requiredAddress("FACET_ADDR")
	if (diamondAddress === newFacetAddress) throw new Error("FACET_ADDR must not equal DIAMOND")
	const facetName = process.env.FACET
	if (!facetName || facetName.trim() === "") throw new Error("FACET must be an explicit contract name or fully-qualified path")
	const mode = process.env.CUT_MODE?.toLowerCase()
	if (mode !== "add" && mode !== "replace" && mode !== "both") throw new Error("CUT_MODE must be explicitly set to add, replace, or both")
	const chain = await ethers.provider.getNetwork()
	const execute = requireExecutionConfirmation(chain.chainId)
	const diamondCode = await requireCode("DIAMOND", diamondAddress)
	const facetCode = await requireCode("FACET_ADDR", newFacetAddress)
	const artifact = await hre.artifacts.readArtifact(facetName)
	if (!artifact.deployedBytecode || artifact.deployedBytecode === "0x") throw new Error(`FACET artifact ${facetName} has no deployed bytecode`)
	if (artifact.deployedBytecode.includes("__$")) {
		throw new Error(
			`FACET ${facetName} requires linked libraries; use the standard deployFacets/applyUpgrade pipeline with explicit library addresses`,
		)
	}
	if (artifact.deployedBytecode.toLowerCase() !== facetCode.toLowerCase()) {
		throw new Error(`FACET_ADDR bytecode does not exactly match the current ${facetName} artifact`)
	}

	const ownership = await ethers.getContractAt(DIAMOND_OWNER_ABI, diamondAddress)
	const owner = await readDiamondOwner(ownership)
	if (!owner) throw new Error(`Could not read diamond owner at ${diamondAddress}`)
	const [signer] = execute ? await ethers.getSigners() : []
	if (execute && !signer) throw new Error("No signer is configured for this network")
	const signerAddress = signer ? ethers.getAddress(await signer.getAddress()) : undefined
	if (execute && signerAddress !== owner)
		throw new Error(`Signer ${signerAddress} is not diamond owner ${owner}; no transaction can be executed safely`)

	const diamondCut = signer
		? await ethers.getContractAt("IDiamondCut", diamondAddress, signer)
		: new ethers.Contract(diamondAddress, (await hre.artifacts.readArtifact("IDiamondCut")).abi, ethers.provider)
	const loupe = new ethers.Contract(diamondAddress, (await hre.artifacts.readArtifact("IDiamondLoupe")).abi, ethers.provider)
	const facetFactory = await ethers.getContractFactory(facetName)
	const selectorsAll = getSelectors(ethers, facetFactory).selectors
	if (selectorsAll.length === 0) throw new Error(`FACET ${facetName} exposes no selectors`)
	if (selectorsAll.includes("0x1f931c1c")) {
		throw new Error("This one-facet helper refuses to replace diamondCut(bytes); use the standard verified upgrade pipeline")
	}

	const addNames = (process.env.ADD_NAMES ?? "")
		.split(",")
		.map(name => name.trim())
		.filter(Boolean)
	const allowedAdds = addNames.length > 0 ? new Set(getSelectors(ethers, facetFactory).get(addNames)) : null

	const selectorOwners = new Map<string, string>()
	for (const currentFacet of await loupe.facets()) {
		for (const selector of currentFacet.functionSelectors) selectorOwners.set(selector, ethers.getAddress(currentFacet.facetAddress))
	}
	const replaceSelectors =
		mode === "replace" || mode === "both"
			? selectorsAll.filter(selector => {
					const current = selectorOwners.get(selector)
					return current !== undefined && current !== newFacetAddress
				})
			: []
	const addSelectors =
		mode === "add" || mode === "both"
			? selectorsAll.filter(selector => !selectorOwners.has(selector) && (!allowedAdds || allowedAdds.has(selector)))
			: []

	const cut: Array<{ facetAddress: string; action: number; functionSelectors: string[] }> = []
	if (replaceSelectors.length > 0) cut.push({ facetAddress: newFacetAddress, action: FacetCutAction.Replace, functionSelectors: replaceSelectors })
	if (addSelectors.length > 0) cut.push({ facetAddress: newFacetAddress, action: FacetCutAction.Add, functionSelectors: addSelectors })

	console.log("Diamond facet-upgrade plan")
	console.log(`  Chain:                ${chain.chainId}`)
	console.log(`  Diamond:              ${diamondAddress} (${(diamondCode.length - 2) / 2} byte runtime)`)
	console.log(`  Diamond owner:        ${owner}`)
	console.log(`  Execution signer:     ${signerAddress ?? "(not loaded in plan mode)"}`)
	console.log(`  Facet artifact:       ${facetName}`)
	console.log(`  Facet address:        ${newFacetAddress} (${(facetCode.length - 2) / 2} byte runtime)`)
	console.log(`  Mode:                 ${mode}`)
	console.log(`  Replace selectors:    ${replaceSelectors.length}`)
	for (const selector of replaceSelectors) console.log(`    ${selector} (currently ${selectorOwners.get(selector)})`)
	console.log(`  Add selectors:        ${addSelectors.length}`)
	for (const selector of addSelectors) console.log(`    ${selector}`)

	if (cut.length === 0) {
		console.log("No selector changes are required; on-chain mapping already satisfies this plan.")
		return
	}

	const estimatedGas = await diamondCut.diamondCut.estimateGas(cut, ethers.ZeroAddress, "0x", { from: owner })
	console.log(`  Estimated gas:        ${estimatedGas}`)
	if (!execute) {
		console.log(`\nPLAN ONLY: no transaction sent. Set EXECUTE=true CONFIRM_CHAIN_ID=${chain.chainId} after reviewing every selector above.`)
		return
	}

	await diamondCut.diamondCut.staticCall(cut, ethers.ZeroAddress, "0x")
	const tx = await diamondCut.diamondCut(cut, ethers.ZeroAddress, "0x")
	console.log(`diamondCut transaction: ${tx.hash} (nonce ${tx.nonce})`)
	const receipt = await tx.wait()
	if (!receipt?.status) throw new Error(`diamondCut transaction ${tx.hash} failed`)
	for (const selector of [...replaceSelectors, ...addSelectors]) {
		const installedAt = ethers.getAddress(await loupe.facetAddress(selector))
		if (installedAt !== newFacetAddress)
			throw new Error(`Post-state mismatch: selector ${selector} maps to ${installedAt}, expected ${newFacetAddress}`)
	}
	console.log(`Verified ${replaceSelectors.length + addSelectors.length} selector mapping(s) in block ${receipt.blockNumber}; gas ${receipt.gasUsed}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
