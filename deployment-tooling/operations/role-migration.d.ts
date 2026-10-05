export function validateRoleProfile(profile: any): void
export function readRoleInventory(
	provider: { send(method: string, args: any[]): Promise<any> },
	profile: any,
	checkpoint: { blockNumber: number; blockHash: string },
	maxMembersPerRole: number,
): Promise<any[]>
export function captureRoleMigration(
	provider: { send(method: string, args: any[]): Promise<any> },
	profile: any,
	sourceRoles: any[],
	checkpoints: any,
): Promise<any>
export function buildRoleMigration(profile: any, snapshot: any): any
export function verifyRoleMigration(
	provider: { send(method: string, args: any[]): Promise<any> },
	plan: any,
	checkpoint: { blockNumber: number; blockHash: string },
): Promise<any>
