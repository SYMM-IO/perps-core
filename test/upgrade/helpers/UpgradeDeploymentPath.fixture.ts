export type DeploymentOutput = {
	libraries: Record<string, string>
	facets: Record<string, { address: string; selectors: string[] }>
}
