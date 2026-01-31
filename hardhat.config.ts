import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatVerify from "@nomicfoundation/hardhat-verify"
import { config as dotenvConfig } from "dotenv"
import { defineConfig } from "hardhat/config"
import { resolve } from "node:path"

import { deployTasks } from "./tasks/deploy/index.js"

const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath) })

const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"
const privateKey = process.env.PRIVATE_KEY || DUMMY_PRIVATE_KEY
const etherscanApiKey = process.env.ETHERSCAN_API_KEY || ""

const createNetworkConfig = (url: string) =>
	({
		type: "http",
		url,
		accounts: [privateKey],
	}) as {
		type: "http"
		url: string
		accounts: string[]
	}

const customChains = [
	{
		network: "base",
		chainId: 8453,
		urls: {
			apiURL: "https://api.basescan.org/api",
			browserURL: "https://basescan.org",
		},
	},
	{
		network: "zkEvm",
		chainId: 1101,
		urls: {
			apiURL: "https://api-zkevm.polygonscan.com/api",
			browserURL: "https://zkevm.polygonscan.com",
		},
	},
	{
		network: "opbnb",
		chainId: 204,
		urls: {
			apiURL: "https://api-opbnb.bscscan.com/api",
			browserURL: "https://opbnb.bscscan.com",
		},
	},
	{
		network: "iota",
		chainId: 8822,
		urls: {
			apiURL: "https://explorer.evm.iota.org/api",
			browserURL: "https://explorer.evm.iota.org",
		},
	},
	{
		network: "mode",
		chainId: 34443,
		urls: {
			apiURL: "https://api.routescan.io/v2/network/mainnet/evm/34443/etherscan",
			browserURL: "https://modescan.io",
		},
	},
	{
		network: "blast",
		chainId: 81457,
		urls: {
			apiURL: "https://api.blastscan.io/api",
			browserURL: "https://blastscan.io",
		},
	},
	{
		network: "mantle",
		chainId: 5000,
		urls: {
			apiURL: "https://api.mantlescan.xyz/api",
			browserURL: "https://mantlescan.xyz",
		},
	},
]

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatEthersPlugin, hardhatVerify],
	tasks: deployTasks,
	solidity: {
		version: "0.8.18",
		settings: {
			metadata: {
				bytecodeHash: "none",
			},
			optimizer: {
				enabled: true,
				runs: 200,
			},
			viaIR: true,
		},
	},
	networks: {
		default: {
			type: "edr-simulated",
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "shanghai",
		},
		docker: {
			type: "http",
			url: process.env.HARDHAT_DOCKER_URL || "http://localhost:8545",
		},
		bsc: createNetworkConfig("https://binance.llamarpc.com"),
		base: createNetworkConfig("https://mainnet.base.org"),
		polygon: createNetworkConfig("https://polygon-rpc.com"),
		iota: createNetworkConfig("https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("https://rpc.blast.io"),
		mode: createNetworkConfig("https://mainnet.mode.network"),
		mantle: createNetworkConfig("https://mantle.drpc.org"),
		mantle2: createNetworkConfig("https://mantle.drpc.org"),
		arbitrum: createNetworkConfig("https://arbitrum.llamarpc.com"),
	},
	verify: {
		etherscan: {
			apiKey: etherscanApiKey,
			// customChains: [...customChains],
		},
	},
	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: "./test/sequential",
	},
	typechain: {
		outDir: resolve(process.cwd(), "src/types"),
	},
	// gasReporter: {
	// 	currency: "USD",
	// 	enabled: false,
	// 	excludeContracts: [],
	// 	src: "./contracts",
	// },
	// contractSizer: {
	// 	alphaSort: false,
	// 	disambiguatePaths: false,
	// 	runOnCompile: false,
	// 	strict: true,
	// },
})
