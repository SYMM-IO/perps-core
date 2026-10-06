import { networkHelpers } from "./hardhat-connection.js"

export async function loadFixture<T>(fixture: () => Promise<T>): Promise<T> {
	return networkHelpers.loadFixture(fixture)
}

export const time = {
	increase: async (seconds: bigint | number) => networkHelpers.time.increase(seconds),
	latest: async () => networkHelpers.time.latest(),
	setNextBlockTimestamp: async (timestamp: bigint | number) => networkHelpers.time.setNextBlockTimestamp(timestamp),
}

export async function setBalance(address: string, balance: bigint | number) {
	return networkHelpers.setBalance(address, balance)
}
