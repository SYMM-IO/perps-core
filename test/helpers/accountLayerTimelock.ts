import type { Signer, TypedDataDomain, TypedDataField } from "ethers"
import { hexlify, randomBytes } from "ethers"

import type { TimelockFacet } from "../../src/types/index.js"
import { time } from "./network-helpers.js"

export const TIMELOCK_APPROVAL_TYPES: Record<string, TypedDataField[]> = {
	TimelockApproval: [
		{ name: "account", type: "address" },
		{ name: "unlocker", type: "address" },
		{ name: "callDataHash", type: "bytes32" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	],
}

export interface TimelockApprovalOptions {
	deadlineOffset?: bigint
	signer?: Signer
	account?: string
	unlockerAddress?: string
}

export type TimelockApprovalSigner = (callDataHash: string, options?: TimelockApprovalOptions) => Promise<TimelockFacet.SignedTimelockApprovalStruct>

export function randomTimelockSalt(): string {
	return hexlify(randomBytes(32))
}

export function createTimelockApprovalSigner(domain: TypedDataDomain, defaultSigner: Signer, defaultAccount: string): TimelockApprovalSigner {
	return async (callDataHash, options = {}) => {
		const signer = options.signer ?? defaultSigner
		const approval = {
			account: options.account ?? defaultAccount,
			unlocker: options.unlockerAddress ?? (await signer.getAddress()),
			callDataHash,
			deadline: BigInt(await time.latest()) + (options.deadlineOffset ?? 60n),
			salt: randomTimelockSalt(),
		}
		const signature = await signer.signTypedData(domain, TIMELOCK_APPROVAL_TYPES, approval)
		return { approval, signature }
	}
}
