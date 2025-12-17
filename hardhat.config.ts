import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import { config as dotenvConfig } from "dotenv"
import { defineConfig } from "hardhat/config"
import { resolve } from "path"
import "./tasks/deploy"

// Load environment variables
const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath) })

// Environment variables with fallbacks
const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"
const privateKey = process.env.PRIVATE_KEY || DUMMY_PRIVATE_KEY
const privateKeyList = (process.env.PRIVATE_KEYS_STR || "").split(",").map(p => p.trim()).filter(Boolean)

const etherscanApiKey = process.env.ETHERSCAN_API_KEY || ""
const hardhatDockerUrl = process.env.HARDHAT_DOCKER_URL || ""

// Network configuration helper
const createNetworkConfig = (url: string) => ({
	url,
	type: "http" as const,
	accounts: [privateKey],
})

const localEdrConfig = {
	type: "edr-simulated" as const,
	allowUnlimitedContractSize: false,
	blockGasLimit: 30000000,
	gas: 30000000,
	hardfork: "shanghai",
	transactionGasCap: 30000000,
}

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers],

	solidity: {
		version: "0.8.21",
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
		default: localEdrConfig,
		hardhat: localEdrConfig,
		docker: {
			type: "http",
			url: hardhatDockerUrl || "http://127.0.0.1:8545",
			allowUnlimitedContractSize: false,
			blockGasLimit: 30000000,
			accounts: privateKeyList,
		},
		bsc: createNetworkConfig("https://binance.llamarpc.com"),
		base: createNetworkConfig("https://api.zan.top/base-mainnet"),
		polygon: createNetworkConfig("https://polygon-rpc.com"),
		iota: createNetworkConfig("https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("https://rpc.blast.io"),
		mode: createNetworkConfig("https://mainnet.mode.network"),
		mantle: createNetworkConfig("https://mantle.drpc.org"),
		mantle2: createNetworkConfig("https://mantle.drpc.org"),
		arbitrum: createNetworkConfig("https://arbitrum.llamarpc.com"),
	},

	chainDescriptors: {
		8453: {
			name: "base",
			blockExplorers: {
				default: {
					apiUrl: "https://api.basescan.org/api",
					url: "https://basescan.org",
				},
			},
		},
		1101: {
			name: "zkEvm",
			blockExplorers: {
				default: {
					apiUrl: "https://api-zkevm.polygonscan.com/api",
					url: "https://zkevm.polygonscan.com",
				},
			},
		},
		204: {
			name: "opbnb",
			blockExplorers: {
				default: {
					apiUrl: "https://api-opbnb.bscscan.com/api",
					url: "https://opbnb.bscscan.com",
				},
			},
		},
		8822: {
			name: "iota",
			blockExplorers: {
				default: {
					apiUrl: "https://explorer.evm.iota.org/api",
					url: "https://explorer.evm.iota.org",
				},
			},
		},
		34443: {
			name: "mode",
			blockExplorers: {
				default: {
					apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/34443/etherscan",
					url: "https://modescan.io",
				},
			},
		},
		81457: {
			name: "blast",
			blockExplorers: {
				default: {
					apiUrl: "https://api.blastscan.io/api",
					url: "https://blastscan.io",
				},
			},
		},
		5000: {
			name: "mantle",
			blockExplorers: {
				default: {
					apiUrl: "https://api.mantlescan.xyz/api",
					url: "https://mantlescan.xyz",
				},
			},
		},
	},

	verify: {
		etherscan: {
			apiKey: etherscanApiKey,
		},
	},

	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: {
			mocha: "./test",
			solidity: "./contracts/dev",
		},
	},

	typechain: {
		outDir: "src/types",
		target: "ethers-v6",
	},

	mocha: {
		timeout: 100000000,
	},

	test: {
		solidity: {
			blockGasLimit: 30000000n,
		},
	},
})
