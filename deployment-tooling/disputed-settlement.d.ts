export const ROLE: string
export const POLICY: string
export const PHASES: string[]
export const SOURCE_FILES: string[]
export function json(value: unknown): string
export function digest(value: unknown): string
export function sameAddress(a: unknown, b: unknown): boolean
export function check(condition: unknown, message: string): asserts condition
export function plain(value: any): any
export function sourceDigest(root: string): string
export function validateInput(input: any): void
export function contracts(provider: any, input: any, root: string): { core: any; layer: any }
export function liquidationLogs(
	provider: any,
	core: any,
	partyA: string,
	detail: any,
	endBlock: number,
	progress?: (message: string) => void,
): Promise<any[]>
export function readSnapshot(
	provider: any,
	input: any,
	root: string,
	plan?: any,
	progress?: (message: string) => void,
	blockTag?: number | string,
): Promise<any>
export function buildPlan(input: any, snapshot: any, iface: any): any
export function verifyPlan(plan: any, input: any): void
export function validateStage(plan: any, snapshot: any, completed?: string[]): void
export function verifyOperationEvents(plan: any, action: any, receipt: any, iface: any): void
export function submitOperation(options: {
	provider: any
	signer?: any
	plan: any
	action: any
	report: any
	save: () => void
	completeRequest: any
	send: any
	suppliedHash?: string
}): Promise<any>
