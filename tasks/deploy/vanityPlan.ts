import { keccak256 } from "ethers"

import { DEPLOYABLE_CONTRACTS } from "../../deployment/deployableContracts.js"
import { type VanityPattern, describePattern, expectedAttempts, patternLength } from "../utils/create2Mining.js"

export const DEFAULT_MINING_BUDGET = 50_000_000

/** A single search may overrun its mean; ten times expected is a 0.005% false trip. */
const CAP_MULTIPLE = 10

export interface Create2Recipe {
	factoryAddress?: string
	groups?: Record<string, VanityPattern>
	overrides?: Record<string, VanityPattern>
	miningBudget?: number
}

export interface VanityPlanEntry {
	key: string
	group: string
	pattern: VanityPattern
	expected: number
}

const isDeclared = (pattern: VanityPattern | undefined): pattern is VanityPattern => patternLength(pattern ?? {}) > 0

export class VanityPlan {
	constructor(
		readonly factoryAddress: string,
		readonly budget: number,
		private readonly groups: Record<string, VanityPattern>,
		private readonly overrides: Record<string, VanityPattern>,
	) {}

	patternFor(key: string): VanityPattern | undefined {
		const override = this.overrides[key]
		// An empty override is a deliberate opt-out, not a fall-through to the group.
		if (override !== undefined) return isDeclared(override) ? override : undefined
		const group = DEPLOYABLE_CONTRACTS[key]
		const pattern = group === undefined ? undefined : this.groups[group]
		return isDeclared(pattern) ? pattern : undefined
	}

	/**
	 * Every registered contract with a resolved pattern. This is an upper bound: a run that
	 * skips a component still counts it, which errs toward refusing an expensive plan.
	 */
	entries(): VanityPlanEntry[] {
		const result: VanityPlanEntry[] = []
		for (const [key, group] of Object.entries(DEPLOYABLE_CONTRACTS)) {
			const pattern = this.patternFor(key)
			if (!pattern) continue
			result.push({ key, group, pattern, expected: expectedAttempts(pattern) })
		}
		return result.sort((a, b) => b.expected - a.expected || a.key.localeCompare(b.key))
	}

	total(): number {
		return this.entries().reduce((sum, entry) => sum + entry.expected, 0)
	}
}

export function buildVanityPlan(create2?: Create2Recipe): VanityPlan | null {
	if (!create2) return null
	const plan = new VanityPlan(
		create2.factoryAddress ?? "",
		create2.miningBudget ?? DEFAULT_MINING_BUDGET,
		create2.groups ?? {},
		create2.overrides ?? {},
	)
	if (plan.entries().length === 0) return null
	if (!plan.factoryAddress) throw new Error("create2 declares a vanity pattern but no factoryAddress; the recipe should have rejected this")
	return plan
}

/** Measures this machine's hash rate so the plan can print time estimates. */
export function calibrateHashRate(durationMs = 200): number {
	const buffer = new Uint8Array(85)
	const start = Date.now()
	let hashes = 0
	while (Date.now() - start < durationMs) {
		for (let i = 0; i < 1000; i++) {
			buffer[52] = hashes & 0xff
			buffer[51] = (hashes >> 8) & 0xff
			keccak256(buffer)
			hashes++
		}
	}
	const elapsed = (Date.now() - start) / 1000
	return Math.max(1, Math.round(hashes / elapsed))
}

function humanDuration(seconds: number): string {
	if (seconds < 1) return "<1s"
	if (seconds < 60) return `~${Math.round(seconds)}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `~${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`
	return `~${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

export function formatVanityPlan(plan: VanityPlan, hashRate: number): string {
	const lines: string[] = []
	lines.push(
		`Vanity mining plan (budget ${plan.budget.toLocaleString()} attempts ${humanDuration(plan.budget / hashRate)} at ${hashRate.toLocaleString()}/s)`,
	)
	lines.push("")
	for (const entry of plan.entries()) {
		lines.push(
			`  ${entry.key.padEnd(38)} ${describePattern(entry.pattern).padEnd(14)} ${entry.expected.toLocaleString().padStart(14)}   ${humanDuration(entry.expected / hashRate)}`,
		)
	}
	const total = plan.total()
	lines.push("  " + "─".repeat(76))
	lines.push(`  ${"total".padEnd(38)} ${"".padEnd(14)} ${total.toLocaleString().padStart(14)}   ${humanDuration(total / hashRate)}`)
	return lines.join("\n")
}

export function assertWithinBudget(plan: VanityPlan, hashRate: number): void {
	const total = plan.total()
	if (total <= plan.budget) return
	throw new Error(
		`${formatVanityPlan(plan, hashRate)}\n\n` +
			`Total ${total.toLocaleString()} attempts exceeds the configured mining budget of ${plan.budget.toLocaleString()}. ` +
			"Shorten the most expensive patterns above or raise create2.miningBudget in the recipe. No transaction was sent.",
	)
}

export class MiningLedger {
	private spent = 0

	constructor(private readonly total: number) {}

	remaining(): number {
		return Math.max(0, this.total - this.spent)
	}

	/** The attempt cap for the next search, and the point at which a wedged search gives up. */
	capFor(expected: number): number {
		const remaining = this.remaining()
		if (remaining === 0) throw new Error("The vanity mining budget is exhausted; raise create2.miningBudget and re-run to resume.")
		return Math.max(1, Math.min(remaining, Math.ceil(expected * CAP_MULTIPLE)))
	}

	spend(attempts: number): void {
		this.spent += attempts
	}
}
