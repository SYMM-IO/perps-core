export interface DeploymentSummaryRow {
	label: string
	address: string | null
	url: string | null
}

export interface DeploymentSummary {
	heading: string
	label: string
	lifecycle: string
	network: string
	chainId: number
	deploymentId: string
	recipeName: string
	recipeDigest: string
	updatedAt?: string
	health: string
	verification: string
	verificationPolicy: string
	transactionCount: number
	rows: DeploymentSummaryRow[]
	actions: Array<{ description: string; method: string; to: string }>
}

export function normalizeDeploymentSummary(report: Record<string, any>, options?: { explorer?: string }): DeploymentSummary
export function renderDeploymentTerminal(summary: DeploymentSummary): string
export function renderDeploymentMarkdown(summary: DeploymentSummary): string
