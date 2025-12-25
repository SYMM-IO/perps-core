declare module "@nomicfoundation/hardhat-toolbox-mocha-ethers" {
	const plugin: import("hardhat/types").HardhatPlugin
	export default plugin
}

declare module "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs" {
	export const anyValue: unknown
}

declare module "hardhat/config" {
	export * from "hardhat/dist/src/config"
}

declare module "hardhat/types/arguments" {
	export * from "hardhat/dist/src/types/arguments"
}

declare module "@ethersproject/units" {
	export function formatEther(value: import("@ethersproject/bignumber").BigNumberish): string
}
