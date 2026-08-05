import { ethers } from "../../../test/helpers/hardhat-connection.js"

export const MUON_FUNCTION_NAMES = ["Trading", "AccountManagement", "Settlement", "ForceClose", "Funding", "LiquidationPartyA", "LiquidationPartyB"]

export const DEFAULT_MUON_FUNCTION_PERMISSIONS = [...MUON_FUNCTION_NAMES]

export type MuonPublicKey = {
	x: string
	parity: number
}

export type MuonVerifierConfig = {
	muonPublicKeys?: MuonPublicKey[]
	muonGatewaySigners?: string[]
	muonFunctionPermissions?: string[]
}

export function validateMuonVerifierConfig(params?: MuonVerifierConfig, label = "newV085Parameters"): string[] {
	if (!params) return []

	const problems: string[] = []
	const publicKeys = params.muonPublicKeys ?? []
	const gatewaySigners = params.muonGatewaySigners ?? []
	const functionPermissions = params.muonFunctionPermissions ?? []

	for (const [index, key] of publicKeys.entries()) {
		if (key.parity !== 0 && key.parity !== 1) {
			problems.push(`${label}.muonPublicKeys[${index}].parity must be 0 or 1`)
		}
		if (key.x === undefined || key.x === "") {
			problems.push(`${label}.muonPublicKeys[${index}].x is required`)
		}
	}

	for (const [index, signer] of gatewaySigners.entries()) {
		if (!ethers.isAddress(signer) || signer === ethers.ZeroAddress) {
			problems.push(`${label}.muonGatewaySigners[${index}] is invalid: ${signer}`)
		}
	}

	if ((publicKeys.length > 0 || gatewaySigners.length > 0) && functionPermissions.length === 0) {
		problems.push(
			`${label}.muonFunctionPermissions is required when muonPublicKeys or muonGatewaySigners are configured; ` +
				`otherwise the verifier keys/gateways are registered without per-function permission`,
		)
	}

	for (const permission of functionPermissions) {
		if (!MUON_FUNCTION_NAMES.includes(permission)) {
			problems.push(`Unknown MuonFunction in ${label}.muonFunctionPermissions: ${permission}. Valid values: ${MUON_FUNCTION_NAMES.join(", ")}`)
		}
	}

	return problems
}

export function requireMuonVerifierConfig(params?: MuonVerifierConfig, label = "newV085Parameters"): void {
	const problems = validateMuonVerifierConfig(params, label)
	if (problems.length > 0) {
		throw new Error(`Invalid Muon verifier config:\n  - ${problems.join("\n  - ")}`)
	}
}
