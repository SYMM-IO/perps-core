import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatVerify from "@nomicfoundation/hardhat-verify"
import { config as dotenvConfig } from "dotenv"
import { configVariable, defineConfig } from "hardhat/config"
import { resolve } from "node:path"

import { deployTasks } from "./tasks/deploy/index.js"

const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath) })

const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"
const protocolAdminKey = (configVariable("TEAM_DEPLOYER") as any) || DUMMY_PRIVATE_KEY
const migratorKey = configVariable("TEAM_MIGRATOR") as any
const etherscanApiKey = (configVariable("ETHERSCAN_APIKEY") as any) || ""

const createNetworkConfig = (network: string, defaultUrl: string) =>
	({
		type: "http",
		url: (configVariable(`RPC_${network.toUpperCase()}`) as any) || defaultUrl,
		accounts: [protocolAdminKey, migratorKey].filter(Boolean),
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
	{
		network: "hyperevm",
		chainId: 999,
		urls: {
			apiURL: "https://api.hyperevmscan.io/api",
			browserURL: "https://hyperevmscan.io",
		},
	},
]

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatEthersPlugin, hardhatVerify],
	tasks: deployTasks,
	chainDescriptors: {
		42161: {
			name: "Arbitrum One",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		5000: {
			name: "Mantle",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
	},
	solidity: {
		profiles: {
			default: {
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
			production: {
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
		bsc: createNetworkConfig("bsc", "https://binance.llamarpc.com"),
		base: createNetworkConfig("base", "https://mainnet.base.org"),
		polygon: createNetworkConfig("polygon", "https://polygon-rpc.com"),
		iota: createNetworkConfig("iota", "https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("blast", "https://rpc.blast.io"),
		mode: createNetworkConfig("mode", "https://mainnet.mode.network"),
		mantle: createNetworkConfig("mantle", "https://mantle.drpc.org"),
		mantle2: createNetworkConfig("mantle2", "https://mantle.drpc.org"),
		hyperevm: createNetworkConfig("hyp/erevm", "https://rpc.hyperliquid.xyz/evm"),
		arbitrum: createNetworkConfig("arbitrum", "https://arbitrum.llamarpc.com"),
		"fork-arbitrum": {
			type: "edr-simulated",
			chainId: 42161,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: (configVariable("RPC_ARBITRUM") as any) || "https://arbitrum.drpc.org",
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
		"fork-base": {
			type: "edr-simulated",
			chainId: 8453,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: (configVariable("RPC_BASE") as any) || "https://base.drpc.org",
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
		"fork-mantle": {
			type: "edr-simulated",
			chainId: 5000,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: (configVariable("RPC_MANTLE") as any) || "https://mantle.drpc.org",
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
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
