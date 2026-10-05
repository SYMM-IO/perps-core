export function captureWiringSnapshot(
	provider: { send(method: string, args: any[]): Promise<any> },
	profile: any,
	checkpoint: { blockNumber: number; blockHash: string },
): Promise<any>
export function buildWiringMigration(profile: any, snapshot: any, replacements: Record<string, string>): any
export function verifyWiringMigration(
	provider: { send(method: string, args: any[]): Promise<any> },
	plan: any,
	checkpoint: { blockNumber: number; blockHash: string },
): Promise<any>
