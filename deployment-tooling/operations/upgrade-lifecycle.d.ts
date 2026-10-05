export const LIVE_UPGRADE_STAGES: readonly string[]
export function rehearsalStatus(evidence: any, currentBindings: any): "not-run" | "failed" | "complete" | "outdated"
export function upgradeCompletionStatus(state: { executionVerified: boolean; serviceRestored: boolean; publicationVerified: boolean }): string
export function publishUpgradeItems(
	items: any[],
	progress: Record<string, string>,
	persist: () => unknown,
	publish: (item: any) => Promise<unknown>,
): Promise<void>
