/**
 * Fail-closed execution interlock for mutating deployment tasks.
 *
 * A mutation is authorized only by the exact pair:
 *   EXECUTE=true CONFIRM_CHAIN_ID=<connected eth_chainId>
 *
 * Legacy DRY_RUN=false never authorizes execution.
 */
export function exactBooleanEnv(name: string, fallback = false): boolean {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	if (raw === "true") return true
	if (raw === "false") return false
	throw new Error(`${name} must be exactly true or false; received ${JSON.stringify(raw)}`)
}

export function requireExecutionConfirmation(chainId: bigint | number): boolean {
	const execute = exactBooleanEnv("EXECUTE")
	const legacyDryRun = process.env.DRY_RUN
	if (legacyDryRun !== undefined) {
		const dryRun = exactBooleanEnv("DRY_RUN")
		if (execute && dryRun) throw new Error("EXECUTE=true and DRY_RUN=true are mutually exclusive")
	}
	if (!execute) return false
	requireChainConfirmation(chainId, "EXECUTE=true")
	return true
}

export function requireChainConfirmation(chainId: bigint | number, action: string): void {
	const connectedChainId = BigInt(chainId)
	const confirmation = process.env.CONFIRM_CHAIN_ID
	if (!confirmation || !/^[1-9]\d*$/.test(confirmation) || BigInt(confirmation) !== connectedChainId) {
		throw new Error(`${action} requires CONFIRM_CHAIN_ID=${connectedChainId}; connected chainId is ${connectedChainId}`)
	}
}

/** Safe Transaction Service POSTs require a per-run env opt-in and Safe binding. */
export function requireSafeProposalConfirmation(chainId: bigint | number, safeAddress: string): boolean {
	const primary = process.env.SUBMIT_SAFE_PROPOSAL
	const legacy = process.env.SAFE_PROPOSAL_SUBMIT
	if (primary !== undefined && legacy !== undefined && primary !== legacy) {
		throw new Error("SUBMIT_SAFE_PROPOSAL and SAFE_PROPOSAL_SUBMIT conflict")
	}
	const raw = primary ?? legacy
	if (raw === undefined || raw === "" || raw === "false") return false
	if (raw !== "true") throw new Error(`SUBMIT_SAFE_PROPOSAL must be exactly true or false; received ${JSON.stringify(raw)}`)
	requireChainConfirmation(chainId, "SUBMIT_SAFE_PROPOSAL=true")

	const normalizedSafe = safeAddress.toLowerCase()
	const confirmedSafe = process.env.CONFIRM_SAFE_ADDRESS?.toLowerCase()
	if (!confirmedSafe || confirmedSafe !== normalizedSafe) {
		throw new Error(`SUBMIT_SAFE_PROPOSAL=true requires CONFIRM_SAFE_ADDRESS=${safeAddress}`)
	}
	return true
}
