import { loadBuild } from "./build.js";
import { atomicWrite } from "./engine.js";
import { CUT_ABI, linkBytecode } from "./model.js";
import { JsonRpcProvider, ContractFactory, Contract } from "ethers";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

// A disposable, local-only Core Diamond for exploring the complete GUI.
// The standard facets are installed; protocol trading configuration is not initialized.
const hre = await createHardhatRuntimeEnvironment({
	networks: { demo: { type: "edr-simulated", chainId: 31337, hardfork: "cancun", blockGasLimit: 60_000_000 } },
});
const server = await hre.network.createServer("demo", "127.0.0.1", 8547);
await server.listen();
const provider = new JsonRpcProvider("http://127.0.0.1:8547", undefined, { cacheTimeout: -1 });
const signer = await provider.getSigner(0),
	owner = await signer.getAddress();
const build = await loadBuild(),
	addresses = {};
async function deploy(name) {
	if (addresses[name]) return addresses[name];
	const artifact = build.catalog[name];
	for (const dependency of artifact.dependencies) await deploy(dependency);
	const receipt = await (await signer.sendTransaction({ data: linkBytecode(artifact.bytecode, artifact.linkReferences, addresses) })).wait();
	addresses[name] = receipt.contractAddress;
	return receipt.contractAddress;
}
for (const name of Object.keys(build.catalog)) await deploy(name);
const diamond = await new ContractFactory(build.diamond.abi, build.diamond.bytecode, signer).deploy(owner, addresses.DiamondCutFacet);
await diamond.waitForDeployment();
const target = await diamond.getAddress();
await (
	await new Contract(target, CUT_ABI, signer).diamondCut(
		Object.values(build.catalog)
			.filter(a => a.kind === "facet" && a.name !== "DiamondCutFacet")
			.map(a => ({ facetAddress: addresses[a.name], action: 0, functionSelectors: Object.keys(a.selectors) })),
		"0x0000000000000000000000000000000000000000",
		"0x",
	)
).wait();
const info = {
	rpc: "http://127.0.0.1:8547",
	chainId: 31337,
	target,
	deployer: owner,
	warning: "Disposable local demo; protocol trading configuration is not initialized",
};
atomicWrite(".symmio/workbench-demo.json", info);
console.log(JSON.stringify(info, null, 2));
console.log("Open the workbench, inspect this target, then compile the checkout. Ctrl+C discards this chain.");
const close = async () => {
	provider.destroy();
	await server.close();
	process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
