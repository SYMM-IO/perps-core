import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import { defineConfig } from "hardhat/config"

// Isolated v0.8.5 build. Do not compile a production recovery artifact with the v0.8.6 configuration.
export default defineConfig({
	plugins: [hardhatToolboxMochaEthers],
	typechain: { outDir: "./artifacts/recovery/types" },
	paths: {
		sources: "./contracts/patches/hyperevm-v085",
		tests: { mocha: "./test/recovery" },
		artifacts: "./artifacts/recovery",
		cache: "./cache/recovery",
	},
	solidity: {
		version: "0.8.18",
		settings: { evmVersion: "paris", metadata: { bytecodeHash: "none" }, optimizer: { enabled: true, runs: 200 }, viaIR: true },
	},
	networks: { default: { type: "edr-simulated", hardfork: "cancun" } },
})
