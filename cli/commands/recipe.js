import { RECIPE_EXAMPLE, displayPath } from "../lib/config-guide.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { blank, c, info, log, ok, title } from "../lib/ui.js";
import fs from "node:fs";
import path from "node:path";

const REVIEWED_PROFILES = Object.freeze({
	arbitrum: { source: RECIPE_EXAMPLE, mode: "live", verify: true },
	"fork-arbitrum": { source: RECIPE_EXAMPLE, mode: "fork", verify: false },
	localhost: { source: RECIPE_EXAMPLE, mode: "local", chainId: 31337, verify: false },
});

function rewriteRelativeSchema(recipe, sourcePath, outputPath) {
	if (typeof recipe.$schema !== "string" || recipe.$schema === "" || /^[a-z]+:/i.test(recipe.$schema)) return;
	const absoluteSchema = path.resolve(path.dirname(sourcePath), recipe.$schema);
	let relativeSchema = path.relative(path.dirname(outputPath), absoluteSchema).split(path.sep).join("/");
	if (!relativeSchema.startsWith(".")) relativeSchema = `./${relativeSchema}`;
	recipe.$schema = relativeSchema;
}

function relativeReference(fromFile, toFile) {
	let relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
	if (!relative.startsWith(".")) relative = `./${relative}`;
	return relative;
}

export function buildInitialRecipe(networkName, sourceRecipe, { sourcePath = RECIPE_EXAMPLE, outputPath, only } = {}) {
	const profile = REVIEWED_PROFILES[networkName];
	if (!profile) {
		throw new Error(`no reviewed deployment recipe exists for ${networkName}; refusing to fabricate protocol, Muon, or governance values`);
	}
	const recipe = structuredClone(sourceRecipe);
	recipe.name = `${networkName}-deployment`;
	recipe.network = { ...recipe.network, name: networkName, chainId: profile.chainId || recipe.network.chainId, mode: profile.mode };
	recipe.execution = { ...recipe.execution, verify: profile.verify };
	if (profile.mode === "local") {
		recipe.secrets = {};
		delete recipe.create2;
		if (recipe.core) {
			recipe.core.collateral = { mode: "deploy" };
			recipe.core.muon = {
				mode: "mock",
				upnlValidTime: recipe.core.muon?.upnlValidTime || "60",
				priceValidTime: recipe.core.muon?.priceValidTime || "60",
			};
			recipe.core.registerDummyAffiliate = false;
		}
	}
	if (only) {
		const standaloneTargets = ["partyB", "symbolManager", "expressProvider", "gaslessLayer"];
		if (!standaloneTargets.includes(only)) {
			throw new Error(`standalone recipe target must be one of ${standaloneTargets.join(", ")}, got ${only}`);
		}
		const targetOutput = outputPath || path.resolve(PROJECT_ROOT, "deployment-recipes", `${networkName}-${only}.json`);
		const reportScope = `${recipe.network.chainId}${profile.mode === "fork" ? "-fork" : ""}`;
		const reportPath = path.resolve(PROJECT_ROOT, "tasks", "data", reportScope, "deployment-report.json");
		recipe.name = `${networkName}-${only}`;
		recipe.governance = { admin: recipe.governance.admin };
		recipe.core = { mode: "reuse", fromReport: relativeReference(targetOutput, reportPath) };
		recipe.partyB = only === "partyB" ? recipe.partyB : { mode: "skip", adlEnabled: false };
		recipe.symbolManager = only === "symbolManager" ? recipe.symbolManager : { mode: "skip" };
		recipe.expressProvider = only === "expressProvider" ? recipe.expressProvider : { mode: "skip" };
		recipe.gaslessLayer = only === "gaslessLayer" ? recipe.gaslessLayer : { mode: "skip" };
	}
	if (outputPath) rewriteRelativeSchema(recipe, sourcePath, outputPath);
	return recipe;
}

function writeJsonAtomically(outputPath, value, { force = false } = {}) {
	if (fs.existsSync(outputPath) && !force) {
		throw new Error(`${displayPath(outputPath)} already exists; choose another --out path or pass --force to replace it`);
	}
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	const temporary = `${outputPath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, outputPath);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function initializeRecipe({ network, only, out, force = false }) {
	const profile = REVIEWED_PROFILES[network];
	if (!profile) {
		throw new Error(`no reviewed deployment recipe exists for ${network}; supported profiles: ${Object.keys(REVIEWED_PROFILES).join(", ")}`);
	}
	if (!fs.existsSync(profile.source)) {
		throw new Error(`reviewed recipe example is missing: ${displayPath(profile.source)}`);
	}
	let sourceRecipe;
	try {
		sourceRecipe = JSON.parse(fs.readFileSync(profile.source, "utf8"));
	} catch (error) {
		throw new Error(`reviewed recipe example is not valid JSON: ${error.message || error}`);
	}
	const outputPath = path.resolve(PROJECT_ROOT, out || path.join("deployment-recipes", `${network}${only ? `-${only}` : ""}.json`));
	const recipe = buildInitialRecipe(network, sourceRecipe, { sourcePath: profile.source, outputPath, only });
	writeJsonAtomically(outputPath, recipe, { force });
	return { outputPath, recipe };
}

export async function recipe(args) {
	const subcommand = args._[1];
	if (subcommand !== "init") throw new Error(`unknown recipe subcommand ${JSON.stringify(subcommand)}`);
	const result = initializeRecipe(args);
	const recipePath = displayPath(result.outputPath);

	title("Deployment recipe created");
	ok(recipePath, `from ${displayPath(RECIPE_EXAMPLE)}`);
	info("this internal adapter created a portable recipe skeleton");
	info("operators should use the guided ./symmio form so values are typed, validated and reviewed");
	blank();
	log(`  ${c.grey("Store the three referenced secrets once:")}`);
	log(`  ${c.cyan("./node_modules/.bin/hardhat keystore set NEW_DEPLOYER")}`);
	log(`  ${c.cyan("./node_modules/.bin/hardhat keystore set RPC_ARBITRUM")}`);
	log(`  ${c.cyan("./node_modules/.bin/hardhat keystore set ETHERSCAN_APIKEY")}`);
	blank();
	log(`  ${c.cyan("./symmio")}`);
	log(`  Choose ${args.only ? `Deploy a contract → ${args.only}` : "Deploy a contract"} and complete the grouped review.`);
	blank();
	return 0;
}
