// Terminal output helpers. Deliberately dependency-free: this CLI drives mainnet
// deployments, so it should have no build step and no supply chain beyond what the repo
// already installs.

import readline from "node:readline/promises"

const useColor = process.stdout.isTTY && !process.env.NO_COLOR

const wrap = code => s => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const c = {
	bold: wrap(1),
	dim: wrap(2),
	red: wrap(31),
	green: wrap(32),
	yellow: wrap(33),
	blue: wrap(34),
	magenta: wrap(35),
	cyan: wrap(36),
	grey: wrap(90),
}

export const SYM = {
	ok: useColor ? "✓" : "OK",
	fail: useColor ? "✗" : "FAIL",
	warn: useColor ? "⚠" : "WARN",
	info: useColor ? "•" : "-",
	arrow: useColor ? "→" : "->",
	skip: useColor ? "⏭" : ">>",
}

export const log = (...a) => console.log(...a)
export const blank = () => console.log("")

export function title(text) {
	blank()
	console.log(c.bold(text))
	console.log(c.grey("─".repeat(Math.min(text.length + 8, 72))))
}

export function ok(msg, detail) {
	console.log(`  ${c.green(SYM.ok)} ${msg}${detail ? c.grey("  " + detail) : ""}`)
}
export function fail(msg, detail) {
	console.log(`  ${c.red(SYM.fail)} ${msg}${detail ? c.grey("  " + detail) : ""}`)
}
export function warn(msg, detail) {
	console.log(`  ${c.yellow(SYM.warn)} ${msg}${detail ? c.grey("  " + detail) : ""}`)
}
export function info(msg, detail) {
	console.log(`  ${c.grey(SYM.info)} ${msg}${detail ? c.grey("  " + detail) : ""}`)
}
export function skip(msg, detail) {
	console.log(`  ${c.grey(SYM.skip)} ${c.grey(msg)}${detail ? c.grey("  " + detail) : ""}`)
}

/** Render rows as an aligned table. rows = array of arrays; head = array of strings. */
export function table(head, rows) {
	if (rows.length === 0) return
	const all = [head, ...rows]
	const widths = head.map((_, i) => Math.max(...all.map(r => String(r[i] ?? "").length)))
	const line = (r, style = x => x) => "  " + r.map((cell, i) => style(String(cell ?? "").padEnd(widths[i]))).join("  ")
	console.log(line(head, c.bold))
	console.log("  " + widths.map(w => c.grey("─".repeat(w))).join("  "))
	for (const r of rows) console.log(line(r))
}

/** Key/value block with aligned keys. */
export function kv(pairs) {
	const width = Math.max(...pairs.map(([k]) => k.length))
	for (const [k, v, style] of pairs) {
		const rendered = style ? style(v) : v
		console.log(`  ${c.grey(k.padEnd(width))}  ${rendered}`)
	}
}

/** Ask a yes/no question. Returns `fallback` when not a TTY (CI, piped input). */
export async function confirm(question, fallback = false) {
	if (!process.stdin.isTTY) {
		console.log(`  ${c.grey(question + " — non-interactive, assuming " + (fallback ? "yes" : "no"))}`)
		return fallback
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	try {
		const answer = (await rl.question(`  ${c.bold(question)} ${c.grey("[y/N]")} `)).trim().toLowerCase()
		return answer === "y" || answer === "yes"
	} finally {
		rl.close()
	}
}

/** Require the user to type an exact phrase. Used before irreversible mainnet actions. */
export async function confirmPhrase(question, phrase) {
	if (!process.stdin.isTTY) {
		console.log(`  ${c.grey(question + " — non-interactive, refusing")}`)
		return false
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	try {
		console.log(`  ${c.bold(question)}`)
		const answer = (await rl.question(`  type ${c.cyan(phrase)} to continue: `)).trim()
		return answer === phrase
	} finally {
		rl.close()
	}
}

export function fatal(msg, hint) {
	blank()
	console.error(`  ${c.red(c.bold("Error"))} ${msg}`)
	if (hint) console.error(`  ${c.grey(hint)}`)
	blank()
	process.exit(1)
}
