// Terminal output helpers. Deliberately dependency-free: this CLI drives mainnet
// deployments, so it should have no build step and no supply chain beyond what the repo
// already installs.
import readline from "node:readline/promises";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = code => s => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

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
};

export const SYM = {
	ok: useColor ? "✓" : "OK",
	fail: useColor ? "✗" : "FAIL",
	warn: useColor ? "⚠" : "WARN",
	info: useColor ? "•" : "-",
	arrow: useColor ? "→" : "->",
	skip: useColor ? "⏭" : ">>",
	prompt: useColor ? "❯" : ">",
	mark: useColor ? "◆" : "*",
};

export const log = (...a) => console.log(...a);
export const blank = () => console.log("");

/** Wipe the screen between wizard steps. No-op when output is not a terminal. */
export function clear() {
	if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}
export function title(text) {
	blank();
	console.log(c.bold(text));
	console.log(c.grey("─".repeat(Math.min(text.length + 8, 72))));
}

/** Session masthead: wordmark, one-line purpose, rule. Used once at the top of a run. */
export function banner(name, tagline) {
	blank();
	console.log(`  ${c.red(SYM.mark)} ${c.bold(name)}${tagline ? `  ${c.grey(tagline)}` : ""}`);
	console.log(`  ${c.grey("─".repeat(64))}`);
}

/** Small step label above a question, so a multi-step flow always shows where you are. */
export function eyebrow(text) {
	blank();
	console.log(`  ${c.grey(String(text).toUpperCase())}`);
}

export function ok(msg, detail) {
	console.log(`  ${c.green(SYM.ok)} ${msg}${detail ? c.grey("  " + detail) : ""}`);
}
export function fail(msg, detail) {
	console.log(`  ${c.red(SYM.fail)} ${msg}${detail ? c.grey("  " + detail) : ""}`);
}
export function warn(msg, detail) {
	console.log(`  ${c.yellow(SYM.warn)} ${msg}${detail ? c.grey("  " + detail) : ""}`);
}
export function info(msg, detail) {
	console.log(`  ${c.grey(SYM.info)} ${msg}${detail ? c.grey("  " + detail) : ""}`);
}
export function skip(msg, detail) {
	console.log(`  ${c.grey(SYM.skip)} ${c.grey(msg)}${detail ? c.grey("  " + detail) : ""}`);
}

/** Render rows as an aligned table. rows = array of arrays; head = array of strings. */
export function table(head, rows) {
	if (rows.length === 0) return;
	const all = [head, ...rows];
	const widths = head.map((_, i) => Math.max(...all.map(r => String(r[i] ?? "").length)));
	const line = (r, style = x => x) => "  " + r.map((cell, i) => style(String(cell ?? "").padEnd(widths[i]))).join("  ");
	console.log(line(head, c.bold));
	console.log("  " + widths.map(w => c.grey("─".repeat(w))).join("  "));
	for (const r of rows) console.log(line(r));
}

/** Key/value block with aligned keys. */
export function kv(pairs) {
	const width = Math.max(...pairs.map(([k]) => k.length));
	for (const [k, v, style] of pairs) {
		const rendered = style ? style(v) : v;
		console.log(`  ${c.grey(k.padEnd(width))}  ${rendered}`);
	}
}

/** Ask a yes/no question. Returns `fallback` when not a TTY (CI, piped input). */
export async function confirm(question, fallback = false) {
	if (!process.stdin.isTTY) {
		console.log(`  ${c.grey(question + " — non-interactive, assuming " + (fallback ? "yes" : "no"))}`);
		return fallback;
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`  ${c.bold(question)} ${c.grey("[y/N]")} `)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

/** Require the user to type an exact phrase. Used before irreversible mainnet actions. */
export async function confirmPhrase(question, phrase) {
	if (!process.stdin.isTTY) {
		console.log(`  ${c.grey(question + " — non-interactive, refusing")}`);
		return false;
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log(`  ${c.bold(question)}`);
		const answer = (await rl.question(`  type ${c.cyan(phrase)} to continue: `)).trim();
		return answer === phrase;
	} finally {
		rl.close();
	}
}

/**
 * Numbered menu. Returns the chosen option's `value`, or null when the operator quits.
 *
 * Pressing enter takes the first option, so the recommended next step is always one keystroke
 * away. Refuses to guess without a TTY: a menu that silently picks an action in CI is exactly
 * how an unintended deployment happens.
 */
/** Print a question's longer explanation — the `?` answer. */
function explain(help) {
	blank();
	for (const line of [].concat(help)) console.log(`  ${c.grey(line)}`);
}

async function selectWith(rl, question, options, extra = {}) {
	let showMenu = true;
	for (;;) {
		if (showMenu) {
			blank();
			console.log(`  ${c.bold(question)}`);
			blank();
			for (const [index, option] of options.entries()) {
				const number = c.cyan(String(index + 1).padStart(2));
				const suffix = index === 0 ? c.grey(" (enter)") : "";
				console.log(`   ${number}  ${option.label}${suffix}`);
				if (option.detail) console.log(`       ${c.grey(option.detail)}`);
			}
			console.log(`    ${c.cyan("q")}  quit${extra.help ? c.grey("   ·   ") + c.cyan("?") + c.grey(" explain") : ""}`);
			blank();
			showMenu = false;
		}
		// Ctrl+D closes stdin and rejects the pending question. That is a request to leave,
		// not a crash, so it exits the same way `q` does.
		let raw;
		try {
			raw = await rl.question(`  ${c.cyan(SYM.prompt)} `);
		} catch {
			blank();
			return null;
		}
		const answer = raw.trim().toLowerCase();
		if (answer === "?" && extra.help) {
			explain(extra.help);
			blank();
			continue;
		}
		if (answer === "q" || answer === "quit" || answer === "exit") return null;
		if (answer === "") return options[0].value;
		const index = Number(answer);
		if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
		console.log(`  ${c.yellow(`Not an option. Enter 1-${options.length}${extra.help ? ", ? to explain" : ""}, or q to quit.`)}`);
	}
}

async function askWith(rl, question, fallback) {
	const suffix = fallback ? c.grey(` [${fallback}]`) : "";
	let raw;
	try {
		raw = await rl.question(`  ${c.bold(question)}${suffix} `);
	} catch {
		return null; // Ctrl+D — treat as "never mind", not an error.
	}
	const answer = raw.trim();
	return answer === "" ? (fallback ?? null) : answer;
}

/**
 * Toggleable checklist. Returns the selected values, or null when the operator quits.
 *
 * Line-based rather than raw-mode arrow keys: it works over ssh, in CI shells and inside any
 * terminal, and it degrades to something readable when copied into a bug report.
 */
async function multiSelectWith(rl, question, options, extra = {}) {
	const chosen = options.map(option => option.selected !== false);
	for (;;) {
		blank();
		console.log(`  ${c.bold(question)}`);
		blank();
		for (const [index, option] of options.entries()) {
			const box = option.locked ? c.grey("[x]") : chosen[index] ? c.green("[x]") : c.grey("[ ]");
			const number = option.locked ? c.grey(" -") : c.cyan(String(index + 1).padStart(2));
			console.log(`   ${number}  ${box} ${option.label}${option.locked ? c.grey("  (required)") : ""}`);
			if (option.detail) console.log(`          ${c.grey(option.detail)}`);
		}
		blank();
		console.log(
			`  ${c.grey('type numbers to turn items on or off (e.g. "2 4"), enter accepts')}${extra.help ? c.grey("  ·  ") + c.cyan("?") + c.grey(" explain") : ""}`,
		);
		let raw;
		try {
			raw = await rl.question(`  ${c.cyan(SYM.prompt)} `);
		} catch {
			blank();
			return null;
		}
		const answer = raw.trim().toLowerCase();
		if (answer === "?" && extra.help) {
			explain(extra.help);
			continue;
		}
		if (answer === "q" || answer === "quit" || answer === "exit") return null;
		if (answer === "") {
			return options.filter((option, index) => option.locked || chosen[index]).map(option => option.value);
		}
		let touched = false;
		for (const token of answer.split(/[\s,]+/)) {
			const index = Number(token);
			if (!Number.isInteger(index) || index < 1 || index > options.length) continue;
			if (options[index - 1].locked) continue;
			chosen[index - 1] = !chosen[index - 1];
			touched = true;
		}
		if (!touched) console.log(`  ${c.yellow(`Nothing to toggle there. Use 1-${options.length}, or enter to accept.`)}`);
	}
}

/** Wait for the operator to come back. Returns false if they quit instead. */
async function pauseWith(rl, message) {
	try {
		await rl.question(`  ${c.bold(message)} `);
		return true;
	} catch {
		blank();
		return false;
	}
}

/**
 * One readline interface for a whole multi-step session.
 *
 * Opening and closing an interface per prompt discards whatever is already buffered on stdin,
 * which silently swallows keystrokes in a wizard. Returns null without a TTY so callers must
 * decide what non-interactive means for them rather than being handed a prompt that cannot ask.
 */
export function createPrompter() {
	if (!process.stdin.isTTY) return null;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return {
		select: (question, options, extra) => selectWith(rl, question, options, extra),
		multiSelect: (question, options, extra) => multiSelectWith(rl, question, options, extra),
		ask: (question, fallback) => askWith(rl, question, fallback),
		pause: message => pauseWith(rl, message),
		close: () => rl.close(),
	};
}

/**
 * Numbered menu. Returns the chosen option's `value`, or null when the operator quits.
 *
 * Pressing enter takes the first option, so the recommended next step is always one keystroke
 * away. Refuses to guess without a TTY: a menu that silently picks an action in CI is exactly
 * how an unintended deployment happens. For several prompts in a row use createPrompter().
 */
export async function select(question, options) {
	if (!process.stdin.isTTY) return null;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await selectWith(rl, question, options);
	} finally {
		rl.close();
	}
}

/** Free-text prompt with an optional default. Returns null without a TTY. */
export async function ask(question, fallback) {
	if (!process.stdin.isTTY) return fallback ?? null;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await askWith(rl, question, fallback);
	} finally {
		rl.close();
	}
}

export function fatal(msg, hint) {
	blank();
	console.error(`  ${c.red(c.bold("Error"))} ${msg}`);
	if (hint) console.error(`  ${c.grey(hint)}`);
	blank();
	process.exit(1);
}
