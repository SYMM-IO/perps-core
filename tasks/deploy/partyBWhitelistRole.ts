import { id, isError } from "ethers"

/** Resolve the installed PartyB implementation, not the version of its local ABI. */
export async function partyBWhitelistRole(contract: any, overrides: Record<string, unknown> = {}) {
	let name = "MULTICAST_WHITELIST_ROLE"
	let value: string
	try {
		value = await contract.MULTICAST_WHITELIST_ROLE(overrides)
	} catch (error) {
		// An absent Solidity selector reverts with empty data. Transport errors, custom
		// errors and unavailable history must never silently select the legacy role.
		if (!isError(error, "CALL_EXCEPTION") || error.data !== "0x") throw error
		name = "MANAGER_ROLE"
		value = await contract.MANAGER_ROLE(overrides)
	}
	if (value.toLowerCase() !== id(name)) throw new Error(`Unexpected PartyB ${name} identifier`)
	return { name, role: value }
}
