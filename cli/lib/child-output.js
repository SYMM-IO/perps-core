// Shared child stdout/stderr reader.
//
// Both the durable task runner and the legacy command adapters spawn Hardhat, and both must
// treat the official keystore password prompt identically: it arrives without a trailing
// newline, so a plain line-splitter would hold it in the buffer and the operator would stare
// at a silent progress panel while a child waits for input. Keeping one implementation means
// the deployment path cannot drift away from the path the prompt tests cover.

export const HARDHAT_KEYSTORE_PROMPT = /\[hardhat-keystore\]\s*(?:Enter the password|Please confirm your password):\s*$/u;
export const TERMINAL_CONTROL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;

/**
 * @param {{
 *   onLine: (line: string, stream: string) => void,
 *   onPrompt?: (prompt: string, channel: {write: (value: any) => void, end: () => void}) => void,
 *   onPromptResolved?: () => void,
 *   channel?: {write: (value: any) => void, end: () => void},
 * }} handlers
 */
export function createChildOutputReader({ onLine, onPrompt, onPromptResolved, channel }) {
	let passwordPromptActive = false;
	const resolvePasswordPrompt = () => {
		if (!passwordPromptActive) return;
		passwordPromptActive = false;
		onPromptResolved?.();
	};
	const consume = (stream, name) => {
		let buffer = "";
		stream.setEncoding("utf8");
		stream.on("data", chunk => {
			const wasPasswordPromptActive = passwordPromptActive;
			// While the child echoes mask characters, keep the prompt open.
			if (wasPasswordPromptActive && /^[*\s]*$/u.test(chunk.replace(TERMINAL_CONTROL, ""))) return;
			resolvePasswordPrompt();
			buffer += chunk;
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line && !(wasPasswordPromptActive && /^\*+$/u.test(line.replace(TERMINAL_CONTROL, "")))) onLine(line, name);
			}
			const plainBuffer = buffer.replace(TERMINAL_CONTROL, "");
			if (onPrompt && channel && HARDHAT_KEYSTORE_PROMPT.test(plainBuffer)) {
				const prompt = plainBuffer.trim();
				buffer = "";
				passwordPromptActive = true;
				onPrompt(prompt, channel);
				onLine(prompt, name);
			}
		});
		stream.on("end", () => {
			if (buffer) onLine(buffer, name);
		});
	};
	return { consume, resolvePasswordPrompt };
}

/**
 * stdin channel for a spawned child that cannot crash the operator CLI.
 *
 * A password can be offered twice in one run (unlock, then "confirm"), and the first delivery
 * ends stdin. Writing to an ended stream raises ERR_STREAM_WRITE_AFTER_END as an unhandled
 * stream error, which would take the whole session down mid-deployment.
 */
export function createStdinChannel(child, onError) {
	child.stdin?.on("error", error => onError?.(error));
	return {
		write: value => {
			if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
			child.stdin.write(value);
			return true;
		},
		end: () => {
			if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
			child.stdin.end();
		},
	};
}
