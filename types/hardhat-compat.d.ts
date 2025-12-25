declare module "hardhat/types" {
	export type HardhatRuntimeEnvironment = import("hardhat/types/hre").HardhatRuntimeEnvironment
}

declare module "hardhat/types/hre" {
	interface HardhatRuntimeEnvironment {
		ethers: import("@nomicfoundation/hardhat-ethers/types").HardhatEthers
		run: (taskName: string, taskArgs?: import("hardhat/types/tasks").TaskArguments) => Promise<any>
	}
}

declare module "hardhat/types/hre.js" {
	interface HardhatRuntimeEnvironment {
		ethers: import("@nomicfoundation/hardhat-ethers/types").HardhatEthers
		run: (taskName: string, taskArgs?: import("hardhat/types/tasks").TaskArguments) => Promise<any>
	}
}

declare module "hardhat/dist/src/types/hre" {
	interface HardhatRuntimeEnvironment {
		ethers: import("@nomicfoundation/hardhat-ethers/types").HardhatEthers
		run: (taskName: string, taskArgs?: import("hardhat/types/tasks").TaskArguments) => Promise<any>
	}
}

declare module "hardhat/dist/src/types/hre.js" {
	interface HardhatRuntimeEnvironment {
		ethers: import("@nomicfoundation/hardhat-ethers/types").HardhatEthers
		run: (taskName: string, taskArgs?: import("hardhat/types/tasks").TaskArguments) => Promise<any>
	}
}

declare module "hardhat" {
	export const ethers: import("@nomicfoundation/hardhat-ethers/types").HardhatEthers
	export const run: (taskName: string, taskArgs?: import("hardhat/types/tasks").TaskArguments) => Promise<any>
}

declare module "@nomicfoundation/hardhat-ethers/signers" {
	export type HardhatEthersSigner = import("@nomicfoundation/hardhat-ethers/types").HardhatEthersSigner
	export type SignerWithAddress = import("@nomicfoundation/hardhat-ethers/types").HardhatEthersSigner
}

declare module "@nomicfoundation/hardhat-verify/internal/utilities" {
	export function sleep(ms: number): Promise<void>
}

declare module "hardhat/types/tasks" {
	interface NewTaskDefinitionBuilder<
		TaskArgumentsT extends import("hardhat/types/tasks").TaskArguments = import("hardhat/types/tasks").TaskArguments
	> {
		setAction(action: any): this
	}

	interface TaskOverrideDefinitionBuilder<
		TaskArgumentsT extends import("hardhat/types/tasks").TaskArguments = import("hardhat/types/tasks").TaskArguments
	> {
		setAction(action: any): this
	}
}

declare module "hardhat/types/tasks.js" {
	interface NewTaskDefinitionBuilder<
		TaskArgumentsT extends import("hardhat/types/tasks").TaskArguments = import("hardhat/types/tasks").TaskArguments
	> {
		setAction(action: any): this
	}

	interface TaskOverrideDefinitionBuilder<
		TaskArgumentsT extends import("hardhat/types/tasks").TaskArguments = import("hardhat/types/tasks").TaskArguments
	> {
		setAction(action: any): this
	}
}

declare module "hardhat/types/config" {
	interface TestPathsUserConfig {
		mocha?: string
		solidity?: string
	}
}
