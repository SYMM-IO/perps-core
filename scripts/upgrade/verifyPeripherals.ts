/**
 * Verify AccountLayer Diamond + InstantLayer deployment and wiring.
 *
 * Standalone script that checks:
 *   1. AccountLayer diamond has all 7 facets registered
 *   2. AccountLayer roles and config are correct
 *   3. InstantLayer config and whitelisting are correct
 *   4. Core diamond has correct roles granted to AL and IL
 *   5. AccountLayer is registered as global hook on core diamond
 *   6. InstantLayer templates exist (if any)
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/verifyPeripherals.ts --network arbitrum
 *
 *   # Custom config
 *   VERIFY_PERIPHERALS_CONFIG=./path/to/config.json \
 *     npx hardhat run scripts/upgrade/verifyPeripherals.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/verifyPeripherals.json
 */
import fs from "fs"

import { ethers } from "../../test/helpers/hardhat-connection.js"

type Config = {
	diamondAddress: string
	accountLayerDiamondAddress: string
	instantLayerAddress: string
	adminAddress: string
}

const CONFIG_FILE = process.env.VERIFY_PERIPHERALS_CONFIG ?? "./scripts/upgrade/config/verifyPeripherals.json"

const ROLES = {
	SIGNER_ADMIN_ROLE: ethers.id("SIGNER_ADMIN_ROLE"),
	AFFILIATE_MANAGER_ROLE: ethers.id("AFFILIATE_MANAGER_ROLE"),
	BALANCE_SETTLER_ROLE: ethers.id("BALANCE_SETTLER_ROLE"),
	INSTANT_LAYER_ROLE: ethers.id("INSTANT_LAYER_ROLE"),
	INTEGRATION_ADMIN_ROLE: ethers.id("INTEGRATION_ADMIN_ROLE"),
	SIGNER_SETTER_ROLE: ethers.id("SIGNER_SETTER_ROLE"),
}

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) {
		throw new Error(`Config file not found: ${CONFIG_FILE}\nCopy config/samples/verifyPeripherals.sample.json and fill in the values.`)
	}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

type CheckResult = { name: string; pass: boolean; detail: string }

async function main() {
	const config = loadConfig()

	const { diamondAddress, accountLayerDiamondAddress, instantLayerAddress, adminAddress } = config

	for (const [label, addr] of Object.entries({ diamondAddress, accountLayerDiamondAddress, instantLayerAddress, adminAddress })) {
		if (!addr || !ethers.isAddress(addr)) {
			throw new Error(`${label} is required and must be a valid address`)
		}
	}

	console.log(`Core Diamond:        ${diamondAddress}`)
	console.log(`AccountLayer:        ${accountLayerDiamondAddress}`)
	console.log(`InstantLayer:        ${instantLayerAddress}`)
	console.log(`Admin:               ${adminAddress}`)
	console.log()

	const results: CheckResult[] = []

	// =========================================================================
	// 1. AccountLayer Diamond - facets registered
	// =========================================================================
	console.log("=== AccountLayer Diamond ===")

	const alLoupe = await ethers.getContractAt("DiamondLoupeFacet", accountLayerDiamondAddress)
	const alFacets = await alLoupe.facets()
	const alFacetCount = alFacets.length

	// 7 facets + DiamondCutFacet = 8 total facet addresses (DiamondCutFacet is separate)
	// But DiamondLoupeFacet is one of the 7, and DiamondCutFacet is added at diamond creation.
	// So we expect 7 facets from the cut + 1 DiamondCutFacet = up to 8 unique addresses.
	// However DiamondLoupeFacet is in the 7, so total unique facet addresses = 8.
	let totalSelectors = 0
	for (const f of alFacets) {
		totalSelectors += f.functionSelectors.length
	}

	const facetCountPass = alFacetCount >= 7
	results.push({
		name: "AL facet count",
		pass: facetCountPass,
		detail: `${alFacetCount} facet addresses, ${totalSelectors} selectors`,
	})

	// 2. AccountLayer - isWhitelistedSymmioCore
	const alView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", accountLayerDiamondAddress)

	const coreWhitelisted = await alView.isWhitelistedSymmioCore(diamondAddress)
	results.push({
		name: "AL whitelisted core diamond",
		pass: coreWhitelisted === true,
		detail: `isWhitelistedSymmioCore(${diamondAddress}) = ${coreWhitelisted}`,
	})

	// 3. AccountLayer - InstantLayer has SIGNER_SETTER_ROLE
	const ilHasSignerSetter = await alView.hasRole(instantLayerAddress, ROLES.SIGNER_SETTER_ROLE)
	results.push({
		name: "AL: IL has SIGNER_SETTER_ROLE",
		pass: ilHasSignerSetter === true,
		detail: `hasRole(InstantLayer, SIGNER_SETTER_ROLE) = ${ilHasSignerSetter}`,
	})

	// 4. AccountLayer - paused state
	const alPaused = await alView.paused()
	results.push({
		name: "AL paused state",
		pass: true, // informational
		detail: `paused = ${alPaused}`,
	})

	// =========================================================================
	// 5. InstantLayer - config
	// =========================================================================
	console.log("\n=== InstantLayer ===")

	const il = await ethers.getContractAt("InstantLayer", instantLayerAddress)

	const ilAccountLayer = await il.accountLayer()
	results.push({
		name: "IL accountLayer",
		pass: ilAccountLayer.toLowerCase() === accountLayerDiamondAddress.toLowerCase(),
		detail: `accountLayer() = ${ilAccountLayer}`,
	})

	const ilDiamondWhitelisted = await il.whitelistedTargets(diamondAddress)
	results.push({
		name: "IL whitelisted core diamond",
		pass: ilDiamondWhitelisted === true,
		detail: `whitelistedTargets(${diamondAddress}) = ${ilDiamondWhitelisted}`,
	})

	const ilALWhitelisted = await il.whitelistedTargets(accountLayerDiamondAddress)
	results.push({
		name: "IL whitelisted AccountLayer",
		pass: ilALWhitelisted === true,
		detail: `whitelistedTargets(${accountLayerDiamondAddress}) = ${ilALWhitelisted}`,
	})

	// 6. InstantLayer - templates
	const nextTemplateId = await il.getNextTemplateId()
	const templateCount = Number(nextTemplateId)
	results.push({
		name: "IL template count",
		pass: true, // informational
		detail: `${templateCount} templates registered`,
	})

	if (templateCount > 0) {
		const templates = await il.getTemplates(0, templateCount)
		for (let i = 0; i < templates.length; i++) {
			const t = templates[i]
			results.push({
				name: `IL template[${i}]`,
				pass: t.active === true,
				detail: `"${t.name}" - ${t.operations.length} ops, active=${t.active}`,
			})
		}
	}

	// =========================================================================
	// 7. Core Diamond - roles granted to AL and IL
	// =========================================================================
	console.log("\n=== Core Diamond Wiring ===")

	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)

	const alHasSignerAdmin = await coreView.hasRole(accountLayerDiamondAddress, ROLES.SIGNER_ADMIN_ROLE)
	results.push({
		name: "Core: AL has SIGNER_ADMIN_ROLE",
		pass: alHasSignerAdmin === true,
		detail: `hasRole(AL, SIGNER_ADMIN_ROLE) = ${alHasSignerAdmin}`,
	})

	const alHasAffiliateManager = await coreView.hasRole(accountLayerDiamondAddress, ROLES.AFFILIATE_MANAGER_ROLE)
	results.push({
		name: "Core: AL has AFFILIATE_MANAGER_ROLE",
		pass: alHasAffiliateManager === true,
		detail: `hasRole(AL, AFFILIATE_MANAGER_ROLE) = ${alHasAffiliateManager}`,
	})

	const alHasBalanceSettler = await coreView.hasRole(accountLayerDiamondAddress, ROLES.BALANCE_SETTLER_ROLE)
	results.push({
		name: "Core: AL has BALANCE_SETTLER_ROLE",
		pass: alHasBalanceSettler === true,
		detail: `hasRole(AL, BALANCE_SETTLER_ROLE) = ${alHasBalanceSettler}`,
	})

	const ilHasInstantLayerRole = await coreView.hasRole(instantLayerAddress, ROLES.INSTANT_LAYER_ROLE)
	results.push({
		name: "Core: IL has INSTANT_LAYER_ROLE",
		pass: ilHasInstantLayerRole === true,
		detail: `hasRole(IL, INSTANT_LAYER_ROLE) = ${ilHasInstantLayerRole}`,
	})

	// 8. Core Diamond - AccountLayer registered as global hook
	const globalHook = await coreView.getAffiliateHook(ethers.ZeroAddress)
	results.push({
		name: "Core: AL is global hook",
		pass: globalHook.toLowerCase() === accountLayerDiamondAddress.toLowerCase(),
		detail: `getAffiliateHook(address(0)) = ${globalHook}`,
	})

	// =========================================================================
	// Summary
	// =========================================================================
	console.log("\n=== Results ===")

	let passCount = 0
	let failCount = 0

	for (const r of results) {
		const icon = r.pass ? "PASS" : "FAIL"
		console.log(`  [${icon}] ${r.name}: ${r.detail}`)
		if (r.pass) passCount++
		else failCount++
	}

	console.log(`\n${passCount} passed, ${failCount} failed, ${results.length} total`)

	if (failCount > 0) {
		process.exitCode = 1
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
