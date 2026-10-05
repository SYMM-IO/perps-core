export function captureConfigurationSnapshot(
	provider: { send(method: string, args: any[]): Promise<any> },
	profile: any,
	checkpoint: { blockNumber: number; blockHash: string },
): Promise<any>
export function buildConfigurationMigration(
	provider: { send(method: string, args: any[]): Promise<any> },
	profile: any,
	snapshot: any,
	target: { address: string; codeHash: string; implementation?: { address: string; slot: string; codeHash: string } },
	checkpoint: { blockNumber: number; blockHash: string },
): Promise<any>
export function verifyConfigurationMigration(
	provider: { send(method: string, args: any[]): Promise<any> },
	plan: any,
	checkpoint: { blockNumber: number; blockHash: string },
): Promise<any>
export function validateConfigurationProfile(profile: any): any
