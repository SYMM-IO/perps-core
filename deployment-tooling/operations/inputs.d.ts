export class OperationError extends Error {
	code: string
	constructor(code: string, message: string)
}
export function hashBytes(bytes: any): string
export function operationDigest(value: any): string
export function validateDocument(kind: string, value: any): any
export function readOperationJson(file: string): { value: any; hash: string }
export function loadOperation(file: string): any
export function assertOperationUnchanged(file: string, digest: string): any
