export function loadConfigurationRequest(file: string): any
export function prepareConfiguration(provider: { send(method: string, args: any[]): Promise<any> }, bundle: any): Promise<any>
export function verifyPreparedConfiguration(
	provider: { send(method: string, args: any[]): Promise<any> },
	bundle: any,
	prepared: any,
	checkpoint: { blockNumber: number; blockHash: string },
	reviewedEvidenceDigest: string,
): Promise<any>
