import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatKeystorePlugin from "@nomicfoundation/hardhat-keystore"
import { configVariable, defineConfig } from "hardhat/config"

export default defineConfig({
	plugins: [hardhatEthersPlugin, hardhatKeystorePlugin],
	networks: {
		arbitrum: {
			type: "http",
			chainId: 42161,
			url: configVariable("RPC_ARBITRUM"),
			accounts: [],
		},
	},
})
