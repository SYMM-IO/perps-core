export const MUON_UPGRADE_ABI: string[]
export function muonUpgradePolicy(input?: any): any
export function validateMuonProfile(profile: any): any
export function captureMuonConfiguration(provider: { send(method: string, args: any[]): Promise<any> }, profile: any, checkpoint: any): Promise<any>
export function verifyMuonConfiguration(
	provider: { send(method: string, args: any[]): Promise<any> },
	profile: any,
	snapshot: any,
	checkpoint: any,
	reviewedDigest: string,
): Promise<any>
