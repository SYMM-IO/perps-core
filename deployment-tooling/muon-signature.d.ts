export const MUON_MIN_REMAINING_SECONDS: number
export const MUON_FETCH_ATTEMPTS: number
export const MUON_CLOCK_WAIT_SECONDS: number
export interface MuonSignatureTiming {
	timestamp: number
	chainTimestamp: number
	validitySeconds: number
	expiresAt: number
	refreshAt: number
	remainingSeconds: number
	reason: "fresh" | "expired" | "near_expiry" | "future_dated"
}
export function muonSignatureTiming(timestamp: number, snapshot: any): MuonSignatureTiming
export function assertMuonSignatureFresh(timestamp: number, snapshot: any): MuonSignatureTiming
export class MuonFreshnessError extends Error {
	timing: MuonSignatureTiming
	constructor(timing: MuonSignatureTiming)
}
