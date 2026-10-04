export const MUON_MIN_REMAINING_SECONDS = 15;
export const MUON_FETCH_ATTEMPTS = 3;
export const MUON_CLOCK_WAIT_SECONDS = 5;

// Deadlines belong to the signed timestamp and Core's effective validity window.
// Changing a timestamp locally would invalidate the oracle signature.
export function muonSignatureTiming(timestamp, snapshot) {
	const chainTimestamp = snapshot.timestamp,
		validitySeconds = snapshot.upnlValidTime;
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Invalid Muon signature timestamp");
	if (!Number.isSafeInteger(chainTimestamp) || chainTimestamp < 0) throw new Error("Invalid chain timestamp");
	if (!Number.isSafeInteger(validitySeconds) || validitySeconds < 0 || !Number.isSafeInteger(timestamp + validitySeconds))
		throw new Error("Invalid Core Muon validity window");
	const expiresAt = timestamp + validitySeconds,
		remainingSeconds = expiresAt - chainTimestamp,
		reason =
			timestamp > chainTimestamp
				? "future_dated"
				: remainingSeconds < 0
					? "expired"
					: remainingSeconds < MUON_MIN_REMAINING_SECONDS
						? "near_expiry"
						: "fresh";
	return { timestamp, chainTimestamp, validitySeconds, expiresAt, refreshAt: expiresAt - MUON_MIN_REMAINING_SECONDS, remainingSeconds, reason };
}

export class MuonFreshnessError extends Error {
	constructor(timing) {
		super(
			`Muon signature ${timing.reason}: chain time ${timing.chainTimestamp}, signed timestamp ${timing.timestamp}, deadline ${timing.expiresAt}, ${timing.remainingSeconds}s remaining; require at least ${MUON_MIN_REMAINING_SECONDS}s`,
		);
		this.name = "MuonFreshnessError";
		this.timing = timing;
	}
}

export function assertMuonSignatureFresh(timestamp, snapshot) {
	const timing = muonSignatureTiming(timestamp, snapshot);
	if (timing.reason !== "fresh") throw new MuonFreshnessError(timing);
	return timing;
}
