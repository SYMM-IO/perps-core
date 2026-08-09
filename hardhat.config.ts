// Deployment recipe bootstrap must run before task modules read process.env.
// sort-imports-ignore
import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatVerify from "@nomicfoundation/hardhat-verify"
import { config as dotenvConfig } from "dotenv"
import { configVariable, defineConfig } from "hardhat/config"
import { resolve } from "node:path"

import { activeDeploymentRecipe } from "./tasks/deploy/recipeRuntime.js"
import { deployTasks } from "./tasks/deploy/index.js"

if (!activeDeploymentRecipe) {
	const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
	dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath) })
}

const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"

function parseBooleanEnv(name: string, fallback = false): boolean {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	if (raw === "true") return true
	if (raw === "false") return false
	throw new Error(`${name} must be exactly true or false; received ${JSON.stringify(raw)}.`)
}

function parseForkBlockNumber(): number | undefined {
	const raw = process.env.FORK_BLOCK_NUMBER
	if (raw === undefined || raw === "" || raw === "0") return undefined
	if (!/^\d+$/.test(raw)) throw new Error(`FORK_BLOCK_NUMBER must be a positive whole number; received ${JSON.stringify(raw)}.`)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`FORK_BLOCK_NUMBER must be a positive safe integer; received ${JSON.stringify(raw)}.`)
	}
	return value
}

function resolveRecipeSecret(name: "deployer" | "rpc" | "explorer"): ReturnType<typeof configVariable> | string | undefined {
	const metadata = activeDeploymentRecipe?.secrets[name]
	if (!metadata) return undefined
	if (metadata.provider === "hardhat-keystore") return configVariable(metadata.key)
	const value = process.env[metadata.key]
	if (!value) {
		throw new Error(
			`Deployment recipe secret ${name} references env://${metadata.key}, but process.env.${metadata.key} is unavailable. ` +
				"Only the exact declared secret key is read; public deployment settings still come exclusively from the JSON recipe.",
		)
	}
	return value
}

export function recipeCredentialPolicy(readOnly: boolean): { deployer: boolean; rpc: true; explorer: boolean } {
	return { deployer: !readOnly, rpc: true, explorer: !readOnly }
}

export function recipeAccountsForNetwork<T>(network: string, recipeNetwork: string, deployerKey: T | undefined, readOnly: boolean): T[] {
	return !readOnly && network === recipeNetwork && deployerKey ? [deployerKey] : []
}

export function recipeAccountsForSimulatedNetwork(readOnly: boolean): [] | undefined {
	return readOnly ? [] : undefined
}

// Recipe mode resolves only its declared secret references. Legacy invocations preserve
// the existing env/keystore behavior when SYMMIO_DEPLOYMENT_RECIPE is absent.
const useKeystore = activeDeploymentRecipe ? false : parseBooleanEnv("USE_KEYSTORE")
const recipeReadOnly = activeDeploymentRecipe ? parseBooleanEnv("SYMMIO_RECIPE_READ_ONLY") : false
const recipeCredentials = recipeCredentialPolicy(recipeReadOnly)
const keystoreDeployerKey = process.env.KEYSTORE_DEPLOYER_KEY || "NEW_DEPLOYER"
const keystoreAccounts = new Set(
	(process.env.KEYSTORE_ACCOUNTS || keystoreDeployerKey)
		.split(",")
		.map(value => value.trim())
		.filter(Boolean),
)
const optionalKeystoreAccount = (name: string) => (useKeystore && keystoreAccounts.has(name) ? configVariable(name) : undefined)
const configuredProtocolAdminKey = activeDeploymentRecipe
	? recipeCredentials.deployer
		? resolveRecipeSecret("deployer")
		: undefined
	: process.env.NEW_DEPLOYER || process.env.TEAM_DEPLOYER || (useKeystore ? configVariable(keystoreDeployerKey) : undefined)
const protocolAdminKey = configuredProtocolAdminKey || DUMMY_PRIVATE_KEY
const migratorKey = activeDeploymentRecipe ? undefined : process.env.TEAM_MIGRATOR || optionalKeystoreAccount("TEAM_MIGRATOR")
const upgradeOperatorKey = activeDeploymentRecipe ? undefined : process.env.TEAM_UPGRADE_OPERATOR || optionalKeystoreAccount("TEAM_UPGRADE_OPERATOR")
const proposerKey = activeDeploymentRecipe ? undefined : process.env.TEAM_PROPOSER || optionalKeystoreAccount("TEAM_PROPOSER")
const etherscanApiKey = activeDeploymentRecipe
	? recipeCredentials.explorer
		? resolveRecipeSecret("explorer") || ""
		: ""
	: process.env.ETHERSCAN_APIKEY || (useKeystore ? configVariable("ETHERSCAN_APIKEY") : "")
const rpcUrl = (network: string, defaultUrl: string, configuredNetwork = network) => {
	if (activeDeploymentRecipe) {
		return configuredNetwork === activeDeploymentRecipe.recipe.network.name ? resolveRecipeSecret("rpc") || defaultUrl : defaultUrl
	}
	const envName = `RPC_${network.toUpperCase()}`
	// The post-deployment verification harness binds bytecode and Hardhat gates to
	// one explicit endpoint, even when USE_KEYSTORE would otherwise select another RPC.
	if (process.env.SYMMIO_RPC_URL_OVERRIDE) return process.env.SYMMIO_RPC_URL_OVERRIDE
	return useKeystore ? configVariable(envName) : process.env[envName] || defaultUrl
}

const accountsForNetwork = (network: string) => {
	if (activeDeploymentRecipe) {
		return recipeAccountsForNetwork(network, activeDeploymentRecipe.recipe.network.name, configuredProtocolAdminKey, recipeReadOnly)
	}
	return configuredProtocolAdminKey ? [configuredProtocolAdminKey, migratorKey, upgradeOperatorKey, proposerKey].filter(Boolean) : []
}

const createNetworkConfig = (network: string, chainId: number, defaultUrl: string) =>
	({
		type: "http",
		chainId,
		url: rpcUrl(network, defaultUrl),
		// Never put the repository's public local-only dummy key on a live network. With
		// no configured signer, reads still work and every attempted write fails closed.
		// Signer index 0 is the deployer throughout the task suite. Never let a role key
		// slide into that position when NEW_DEPLOYER/TEAM_DEPLOYER is missing.
		accounts: accountsForNetwork(network),
	}) as {
		type: "http"
		chainId: number
		url: string
		accounts: string[]
	}

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
			blockExplorers: {
				etherscan: { name: "Mantlescan", url: "https://mantlescan.xyz" },
			},
		},
		8453: {
			name: "Base",
			// Override default chainType (op) to generic. Hardhat 3's config validator
			// only accepts L1 hardfork names in hardforkHistory; the runtime then needs
			// the chainType to match. For our upgrade scripts (view calls + diamondCut)
			// L1 EVM semantics are sufficient.
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		56: {
			name: "BNB Smart Chain",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		146: {
			name: "Sonic",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: { name: "SonicScan", url: "https://sonicscan.org" },
			},
		},
		9745: {
			name: "Plasma Mainnet Beta",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: { name: "PlasmaScan", url: "https://plasmascan.to" },
			},
		},
		80094: {
			name: "Berachain",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: { name: "BeraScan", url: "https://berascan.com" },
			},
		},
		8822: {
			name: "IOTA EVM",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				blockscout: {
					name: "IOTA EVM Explorer",
					url: "https://explorer.evm.iota.org",
					apiUrl: "https://explorer.evm.iota.org/api",
				},
			},
		},
		34443: {
			name: "Mode",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				blockscout: {
					name: "Mode Explorer",
					url: "https://explorer.mode.network",
					apiUrl: "https://explorer.mode.network/api",
				},
			},
		},
		2632500: {
			name: "COTI",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				blockscout: {
					name: "COTI Scan",
					url: "https://mainnet.cotiscan.io",
					apiUrl: "https://mainnet.cotiscan.io/api",
				},
			},
		},
		999: {
			name: "HyperEVM",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: {
					name: "Hyperevmscan",
					url: "https://hyperevmscan.io",
				},
			},
		},
		1329: {
			name: "Sei",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: {
					name: "SeiScan",
					url: "https://seiscan.io",
				},
			},
		},
		81457: {
			name: "Blast",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: { name: "Blastscan", url: "https://blastscan.io" },
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
			accounts: recipeAccountsForSimulatedNetwork(recipeReadOnly),
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "shanghai",
		},
		docker: {
			type: "http",
			url: activeDeploymentRecipe ? rpcUrl("docker", "http://localhost:8545") : process.env.HARDHAT_DOCKER_URL || "http://localhost:8545",
			accounts: accountsForNetwork("docker") as string[],
		},
		// A persistent local node (`./node_modules/.bin/hardhat node`). Unlike the in-process `default`
		// network, state survives the task, so a deployment can be inspected afterwards.
		localhost: {
			type: "http",
			chainId: 31337,
			url: activeDeploymentRecipe ? rpcUrl("localhost", "http://127.0.0.1:8545") : process.env.RPC_LOCALHOST || "http://127.0.0.1:8545",
			accounts: (activeDeploymentRecipe
				? recipeAccountsForNetwork("localhost", activeDeploymentRecipe.recipe.network.name, protocolAdminKey, recipeReadOnly)
				: [protocolAdminKey, migratorKey, upgradeOperatorKey, proposerKey].filter(Boolean)) as string[],
		},
		bsc: createNetworkConfig("bsc", 56, "https://bsc-rpc.publicnode.com"),
		base: createNetworkConfig("base", 8453, "https://mainnet.base.org"),
		sonic: createNetworkConfig("sonic", 146, "https://rpc.soniclabs.com"),
		plasma: createNetworkConfig("plasma", 9745, "https://rpc.plasma.to"),
		bera: createNetworkConfig("bera", 80094, "https://rpc.berachain.com"),
		polygon: createNetworkConfig("polygon", 137, "https://polygon-rpc.com"),
		iota: createNetworkConfig("iota", 8822, "https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("blast", 81457, "https://rpc.blast.io"),
		mode: createNetworkConfig("mode", 34443, "https://mainnet.mode.network"),
		mantle: createNetworkConfig("mantle", 5000, "https://mantle.drpc.org"),
		hyperevm: createNetworkConfig("hyperevm", 999, "https://rpc.hyperliquid.xyz/evm"),
		sei: createNetworkConfig("sei", 1329, "https://evm-rpc.sei-apis.com"),
		arbitrum: createNetworkConfig("arbitrum", 42161, "https://arbitrum.llamarpc.com"),
		"fork-hyperevm": {
			type: "edr-simulated",
			accounts: recipeAccountsForSimulatedNetwork(recipeReadOnly),
			chainId: 999,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: activeDeploymentRecipe
					? rpcUrl("hyperevm", "https://rpc.hyperliquid.xyz/evm", "fork-hyperevm")
					: process.env.RPC_HYPEREVM || "https://rpc.hyperliquid.xyz/evm",
				blockNumber: parseForkBlockNumber(),
			},
		},
		coti: createNetworkConfig("coti", 2632500, "https://mainnet.coti.io/rpc"),
		"fork-arbitrum": {
			type: "edr-simulated",
			accounts: recipeAccountsForSimulatedNetwork(recipeReadOnly),
			chainId: 42161,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("arbitrum", "https://arbitrum.drpc.org", "fork-arbitrum"),
				blockNumber: parseForkBlockNumber(),
			},
		},
		"fork-base": {
			type: "edr-simulated",
			accounts: recipeAccountsForSimulatedNetwork(recipeReadOnly),
			chainId: 8453,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("base", "https://base.drpc.org", "fork-base"),
				blockNumber: parseForkBlockNumber(),
			},
		},
		"fork-bsc": {
			type: "edr-simulated",
			accounts: recipeAccountsForSimulatedNetwork(recipeReadOnly),
			chainId: 56,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("bsc", "https://bsc-rpc.publicnode.com", "fork-bsc"),
				blockNumber: parseForkBlockNumber(),
			},
		},
		"fork-mantle": {
			type: "edr-simulated",
			accounts: recipeAccountsForSimulatedNetwork(recipeReadOnly),
			chainId: 5000,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("mantle", "https://mantle.drpc.org", "fork-mantle"),
				blockNumber: parseForkBlockNumber(),
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
