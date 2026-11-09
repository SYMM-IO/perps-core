// Restore the execution-context visualizations from 87f5ba7e, scoped to this guide.
// These deterministic examples model core authority only; they send no transactions.
(() => {
	const escapeHtml = value =>
		String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
	const formatCall = call => escapeHtml(call).replace(/([a-z0-9])([A-Z])/g, "$1<wbr>$2");
	const formatSourceName = name => escapeHtml(name).replace(/_/g, "_<wbr>");
	const formatSourceExpression = expression =>
		expression
			.split(" | ")
			.map(term => `<span class="bit-expression-term">${formatSourceName(term)}</span>`)
			.join(" |<wbr> ");
	// Keep the existing shortcut in the header so it never covers a bit value.
	const backToTop = document.querySelector("[data-back-to-top]");
	const pageActions = document.querySelector(".docs-header .top-actions");
	if (backToTop && pageActions) {
		pageActions.prepend(backToTop);
		backToTop.addEventListener("click", () => document.querySelector("main")?.focus({ preventScroll: true }));
	}
	document.querySelectorAll(".gas-guide .code-frame").forEach(frame => {
		const wrap = [...frame.querySelectorAll(".code-actions button")].find(button => button.textContent.trim() === "Wrap");
		if (wrap) wrap.click();
	});
	const bitMask = index => 1n << BigInt(index);
	const INSTANT_CONTEXT_ACTIVE = bitMask(0);
	const CALL_FROM_INSTANT_LAYER = bitMask(1);
	const INSTANT_OPEN_MODE = bitMask(2);
	const INSTANT_CONTEXT_FLAGS = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER | INSTANT_OPEN_MODE;
	const SNAPSHOT_ACTIVE = bitMask(255);
	const SNAPSHOT_TRANSIENT = bitMask(254);
	const SNAPSHOT_PERSISTENT_CALL = bitMask(1);
	const SNAPSHOT_PERSISTENT_OPEN = bitMask(2);

	// The only five positions any of these words ever uses.
	const TRACKED_BITS = [255, 254, 2, 1, 0];
	const BIT_LABELS = {
		255: { snapshotName: "EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE", live: null, snapshot: "This is a real snapshot, not the 0 sentinel." },
		254: { snapshotName: "EXTERNAL_CONTEXT_SNAPSHOT_TRANSIENT", live: null, snapshot: "The suspended authority came from transient storage." },
		2: {
			liveName: "INSTANT_OPEN_MODE",
			snapshotName: "EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_OPEN",
			live: "InstantOpen accounting mode is enabled.",
			snapshot: "Suspended InstantOpen accounting-mode flag.",
		},
		1: {
			liveName: "CALL_FROM_INSTANT_LAYER",
			snapshotName: "EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_CALL",
			live: "This call is routed by InstantLayer.",
			snapshot: "Suspended routing flag.",
		},
		0: {
			liveName: "INSTANT_CONTEXT_ACTIVE",
			live: "A scope is open. Zero here is what makes every reader fall back.",
			snapshot: "Inherited from the live word and restored with bits 1–2; bit 254, not bit 0, selects the restoration source.",
		},
	};

	const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
	const SIGNER_ADDRESS = "0x00000000000000000000000000000000000000D4";
	const ATTACKER_ADDRESS = "0x00000000000000000000000000000000000000EE";

	const isBitSet = (word, index) => (word & bitMask(index)) !== 0n;
	const sourceBitName = (word, kind, index) => {
		const label = BIT_LABELS[index];
		if (index >= 254) return kind === "snapshot" ? label.snapshotName : null;
		if (kind === "snapshot" && !isBitSet(word, 254) && label.snapshotName) return label.snapshotName;
		return label.liveName;
	};
	const toFullHex = word => `0x${word.toString(16).padStart(64, "0")}`;
	const toShortHex = word => {
		const hex = word.toString(16).padStart(64, "0");
		if (/^0+$/.test(hex)) return "0x00";
		return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
	};
	const changedBits = (before, after) => TRACKED_BITS.filter(index => isBitSet(before, index) !== isBitSet(after, index));
	const setBitsOf = word => TRACKED_BITS.filter(index => isBitSet(word, index));

	// Renders one 256-bit word as five meaningful cells plus a collapsed middle.
	const renderWordStrip = (word, options = {}) => {
		const { interactive = false, kind = "live", changed = [], middle = "zero" } = options;
		const cell = index => {
			const on = isBitSet(word, index);
			const classes = ["bit-cell"];
			if (on) classes.push("is-set");
			if (changed.includes(index)) classes.push("is-changed");
			if (interactive) classes.push("is-interactive");
			const meaning = BIT_LABELS[index][kind === "snapshot" ? "snapshot" : "live"];
			const title = meaning ? `bit ${index} — ${sourceBitName(word, kind, index)}: ${meaning}` : `bit ${index} — unused in a ${kind} word`;
			const tag = interactive ? "button" : "div";
			const attributes = interactive ? ` type="button" data-bit="${index}" aria-label="${escapeHtml(title)}" aria-pressed="${on}"` : "";
			return `<${tag} class="${classes.join(" ")}"${attributes} title="${escapeHtml(title)}"><small>${index}</small><b>${on ? "1" : "0"}</b></${tag}>`;
		};
		const middleLabel = middle === "ones" ? "bits 253…3 · all one" : "bits 253…3 · all zero";
		return `
			<div class="bit-strip" role="group" aria-label="256-bit word, high and low bit positions">
				${cell(255)}${cell(254)}
				<div class="bit-gap ${middle === "ones" ? "is-ones" : ""}"><span>${middleLabel}</span></div>
				${cell(2)}${cell(1)}${cell(0)}
			</div>
		`;
	};

	const renderWordCard = (word, options = {}) => {
		const { label, sublabel = "", kind = "live", changed = [], interactive = false, middle = "zero" } = options;
		const set = setBitsOf(word);
		const legend = set.length
			? set
					.map(index => {
						const name = sourceBitName(word, kind, index);
						return `<span class="bit-tag ${changed.includes(index) ? "is-changed" : ""}">bit ${index} ${name ? `<code>${formatSourceName(name)}</code>` : "unused in a live word"}</span>`;
					})
					.join("")
			: `<span class="bit-tag is-empty">no bits set — the word is <code>0</code></span>`;
		return `
			<div class="bit-word ${changed.length ? "is-touched" : ""}">
				<div class="bit-word-head">
					<span class="bit-word-name">${label}<small>${sublabel ? `${formatSourceName(sublabel)} · ` : ""}${interactive ? "Toggle bits" : "Read only"}</small></span>
					<span class="bit-word-value" title="${toFullHex(word)}"><code>${toShortHex(word)}</code><small>${word === 0n ? "0" : `0b${word & INSTANT_CONTEXT_FLAGS ? (word & INSTANT_CONTEXT_FLAGS).toString(2).padStart(3, "0") : "000"} in the low bits`}</small></span>
				</div>
				${renderWordStrip(word, { kind, changed, interactive, middle })}

				<div class="bit-legend">${legend}</div>
			</div>
		`;
	};

	// One word holding an address rather than flags: bits 159-0 are the value.
	const renderAddressWord = (address, options = {}) => {
		const { label, sublabel = "", changed = false } = options;
		const empty = address === ZERO_ADDRESS;
		return `
			<div class="bit-word is-value ${changed ? "is-touched" : ""}">
				<div class="bit-word-head">
					<span class="bit-word-name">${label}${sublabel ? ` <small>${sublabel}</small>` : ""}</span>
					<span class="bit-word-value"><code>${empty ? "0x00" : `${address.slice(0, 6)}…${address.slice(-4)}`}</code><small>bits 159…0</small></span>
				</div>
				<div class="bit-value-bar ${empty ? "is-empty" : ""} ${changed ? "is-changed" : ""}">
					<span>${empty ? "empty — no address installed" : `address ${escapeHtml(address)}`}</span>
				</div>
			</div>
		`;
	};

	const renderMarkerWord = (marker, options = {}) => {
		const { label, sublabel = "", changed = false } = options;
		return `
			<div class="bit-word is-marker ${changed ? "is-touched" : ""}">
				<div class="bit-word-head">
					<span class="bit-word-name">${label}${sublabel ? ` <small>${sublabel}</small>` : ""}</span>
					<span class="bit-word-value"><code>${marker}</code><small>whole word</small></span>
				</div>
				<div class="bit-value-bar ${marker ? "" : "is-empty"} ${changed ? "is-changed" : ""}">
					<span>${marker ? "transient storage owns the signer" : "no transient signer scope"}</span>
				</div>
			</div>
		`;
	};

	// ── Panel 1: read one word ───────────────────────────────────────────────
	const WORD_PRESETS = [
		{ label: "No scope", value: 0n, kind: "live", note: "Every effective-value reader falls back to the persistent compatibility field." },
		{
			label: "Routing only",
			value: INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER,
			kind: "live",
			note: "A scope opened with <code>instantOpenMode = false</code>: routing authority, no InstantOpen accounting mode.",
		},
		{
			label: "InstantOpen",
			value: INSTANT_CONTEXT_FLAGS,
			kind: "live",
			note: "What <code>beginInstantLayerExecution(true)</code> stores. Decimal 7, and the whole of the live word's vocabulary.",
		},
		{
			label: "Transient snapshot",
			value: SNAPSHOT_ACTIVE | SNAPSHOT_TRANSIENT | INSTANT_CONTEXT_FLAGS,
			kind: "snapshot",
			note: "The value a boundary hands back after suspending an InstantOpen scope: five bits set, the rest of the word zero.",
		},
		{
			label: "Persistent snapshot",
			value: SNAPSHOT_ACTIVE | SNAPSHOT_PERSISTENT_CALL | SNAPSHOT_PERSISTENT_OPEN,
			kind: "snapshot",
			note: "The historical persistent-field fallback builds this value from GlobalAppStorage mode fields. Bit 0 stays clear; bit 254 selects the restore branch.",
		},
	];

	const installWordReaderTool = mount => {
		const scope = mount.dataset.wordReaderTool === "snapshot" ? "snapshot" : "live";
		const presets = WORD_PRESETS.filter(preset => preset.kind === scope);
		const initial = scope === "snapshot" ? 0 : presets.length - 1;
		let word = presets[initial].value;
		let kind = scope;
		const headingId = `execution-context-${scope}-word-tool-title`;
		mount.setAttribute("aria-labelledby", headingId);
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">${scope === "snapshot" ? "Snapshot word" : "Live context word"}</p>
					<h4 id="${headingId}">${scope === "snapshot" ? "What suspension carries forward" : "The word every reader consults"}</h4>
				</div>
				<p>${scope === "snapshot" ? "The two reachable forms record their source in bit 254 and carry the suspended authority in the low bits." : "The three live states share one word; each reader follows bit 0 before interpreting bits 1 and 2."}</p>
			</div>
			<div class="bit-body">
				<div class="bit-preset-row" role="group" aria-label="Example words">
					${presets.map((preset, index) => `<button class="bit-chip" type="button" data-preset="${index}" aria-pressed="${index === initial}">${preset.label}</button>`).join("")}
				</div>
				<div data-word-mount></div>
				<div class="bit-readout" data-readout></div><p class="visually-hidden" data-word-status role="status"></p>
			</div>
		`;
		const wordMount = mount.querySelector("[data-word-mount]");
		const readout = mount.querySelector("[data-readout]");
		const render = () => {
			wordMount.innerHTML = renderWordCard(word, {
				label: kind === "snapshot" ? "Snapshot word" : "Live context word",
				sublabel: kind === "snapshot" ? "returned by suspend, never stored live" : "TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT",
				kind,
				interactive: scope === "live",
			});
			wordMount.querySelectorAll("[data-bit]").forEach(button => {
				button.addEventListener("click", () => {
					const index = button.dataset.bit;
					word ^= bitMask(Number(index));
					render();
					wordMount.querySelector(`[data-bit="${index}"]`).focus({ preventScroll: true });
				});
			});
			mount.querySelectorAll("[data-preset]").forEach(button => {
				const preset = presets[Number(button.dataset.preset)];
				const selected = preset.kind === kind && preset.value === word;
				button.classList.toggle("is-active", selected);
				button.setAttribute("aria-pressed", String(selected));
			});
			mount.querySelector("[data-word-status]").textContent =
				kind === "live"
					? `Live context low bits ${(word & INSTANT_CONTEXT_FLAGS).toString(2).padStart(3, "0")}. ${isBitSet(word, 0) ? "Transient scope active." : "Persistent fallback."}`
					: `${isBitSet(word, 254) ? "Transient" : "Persistent"} snapshot selected.`;
			const rows = [];
			rows.push(`<div class="bit-readout-row"><span>Full hex</span><code class="is-wide">${toFullHex(word)}</code></div>`);
			rows.push(`<div class="bit-readout-row"><span>Decimal</span><code class="is-wide">${word.toString(10)}</code></div>`);
			rows.push(
				`<div class="bit-readout-row"><span>Full binary (256 bits)</span><code class="is-wide">${word.toString(2).padStart(256, "0")}</code></div>`,
			);
			rows.push(
				`<div class="bit-readout-row"><span>Equivalent bit expression</span><code class="bit-expression">${formatSourceExpression(describeWordAsSource(word, kind))}</code></div>`,
			);
			if (kind === "live") {
				const active = (word & INSTANT_CONTEXT_ACTIVE) !== 0n;
				rows.push(
					`<div class="bit-readout-row"><span><code>isTransientContextActive()</code></span><strong class="${active ? "is-true" : "is-false"}">${active}</strong></div>`,
				);
				rows.push(
					`<div class="bit-readout-row"><span><code>isCallFromInstantLayer()</code></span><strong class="${active && (word & CALL_FROM_INSTANT_LAYER) !== 0n ? "is-true" : "is-false"}">${
						active ? (word & CALL_FROM_INSTANT_LAYER) !== 0n : "falls back to storage"
					}</strong></div>`,
				);
				rows.push(
					`<div class="bit-readout-row"><span><code>isInstantOpenMode()</code></span><strong class="${active && (word & INSTANT_OPEN_MODE) !== 0n ? "is-true" : "is-false"}">${
						active ? (word & INSTANT_OPEN_MODE) !== 0n : "falls back to storage"
					}</strong></div>`,
				);
			}
			const warning =
				kind === "live" && (isBitSet(word, 255) || isBitSet(word, 254))
					? "Illustrative unreachable live word: bits 254 and 255 belong to snapshots, not the live context."
					: describeWordWarning(word, kind);
			readout.innerHTML = `${rows.join("")}${warning ? `<p class="bit-warn">${warning}</p>` : ""}`;
		};
		mount.querySelectorAll("[data-preset]").forEach(button => {
			button.addEventListener("click", () => {
				const preset = presets[Number(button.dataset.preset)];
				word = preset.value;
				kind = preset.kind;
				render();
			});
		});
		render();
	};

	const describeWordAsSource = (word, kind) => {
		const parts = [];
		if (kind === "snapshot") {
			if (isBitSet(word, 255)) parts.push("EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE");
			if (isBitSet(word, 254)) parts.push("EXTERNAL_CONTEXT_SNAPSHOT_TRANSIENT");
		}
		if (isBitSet(word, 2))
			parts.push(kind === "snapshot" && !isBitSet(word, 254) ? "EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_OPEN" : "INSTANT_OPEN_MODE");
		if (isBitSet(word, 1))
			parts.push(kind === "snapshot" && !isBitSet(word, 254) ? "EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_CALL" : "CALL_FROM_INSTANT_LAYER");
		if (isBitSet(word, 0)) parts.push("INSTANT_CONTEXT_ACTIVE");
		const namedMask = kind === "snapshot" ? INSTANT_CONTEXT_FLAGS | SNAPSHOT_ACTIVE | SNAPSHOT_TRANSIENT : INSTANT_CONTEXT_FLAGS;
		const unnamedBits = word & ~namedMask;
		if (unnamedBits) parts.push(`0x${unnamedBits.toString(16)}`);
		return parts.length ? parts.join(" | ") : "0";
	};

	const describeWordWarning = (word, kind) => {
		if (kind === "live" && word !== 0n && !isBitSet(word, 0)) {
			return "With no active transient scope, this word is ignored. With bit 0 clear, <code>isCallFromInstantLayer</code> and <code>isInstantOpenMode</code> both skip the word entirely and read the persistent field, so bits 1 and 2 are dead here.";
		}
		if (kind === "snapshot" && word !== 0n && !isBitSet(word, 255)) {
			return "<code>restoreExecutionContextAfterExternalCall</code> rejects this with <code>ExternalCallContextNotSuspended</code>: a non-zero value without bit 255 was never produced by suspend.";
		}
		if (kind === "snapshot" && isBitSet(word, 254) && !isBitSet(word, 0)) {
			return "Malformed and unreachable: a transient snapshot copies a live word whose bit 0 is set. Restore would accept this shape but rebuild a non-active word that the normal lifecycle cannot close.";
		}
		return "";
	};

	// ── Panel 2: the batch lifecycle, slot by slot ───────────────────────────
	const LIB = "LibExecutionContext.sol";

	const buildLifecycle = ({ mechanism, hook }) => {
		const transient = mechanism === "transient";
		const state = {
			context: 0n,
			signerValue: ZERO_ADDRESS,
			signerActive: 0,
			persistentRouted: !transient,
			persistentOpen: !transient,
			persistentSigner: transient ? ZERO_ADDRESS : SIGNER_ADDRESS,
			heldSnapshot: 0n,
			heldSigner: ZERO_ADDRESS,
			heldWasTransient: false,
		};
		const steps = [];
		let halted = false;
		const record = (step, mutate) => {
			if (halted) {
				steps.push({
					...step,
					skipped: true,
					state: { ...state },
					touched: {
						context: [],
						signerValue: false,
						signerActive: false,
						persistent: false,
					},
				});
				return;
			}
			const before = { ...state };
			const outcome = mutate ? mutate() || {} : {};
			if (outcome.revert) halted = true;
			steps.push({
				...step,
				detail: outcome.detail || step.detail,
				revert: outcome.revert,
				state: { ...state },
				touched: {
					context: changedBits(before.context, state.context),
					signerValue: before.signerValue !== state.signerValue,
					signerActive: before.signerActive !== state.signerActive,
					persistent:
						before.persistentRouted !== state.persistentRouted ||
						before.persistentOpen !== state.persistentOpen ||
						before.persistentSigner !== state.persistentSigner,
				},
			});
		};

		if (transient) {
			record(
				{
					actor: "InstantLayer",
					call: "beginInstantLayerExecution(true)",
					source: `${LIB} · L124`,
					detail: "Refuses to open over another live scope, then builds the word: bit 0 selects transient context, bit 1 enables routing, and bit 2 enables InstantOpen accounting. The native path uses one <code>tstore</code> here.",
				},
				() => {
					state.context = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER | INSTANT_OPEN_MODE;
				},
			);
			record(
				{
					actor: "Authorized router",
					call: "setTransientSigner(0x…D4)",
					source: `${LIB} · L208`,
					detail: "Value and marker move together. The marker is what tells later readers that transient storage — not the persistent <code>signer</code> field — owns this identity.",
				},
				() => {
					state.signerValue = SIGNER_ADDRESS;
					state.signerActive = 1;
				},
			);
		} else {
			record(
				{
					actor: "Historical persistent-field fallback",
					call: "legacy persistent fields already set",
					source: "GlobalAppStorage · callFromInstantLayer, instantOpenMode, signer",
					detail: "The path begins with pre-existing persistent mode flags and a persistent signer. No transient scope is open, so the live word stays <code>0</code> and effective-value readers take the fallback branch.",
				},
				() => {},
			);
		}

		record(
			{
				actor: "openPosition",
				call: "isInstantOpenMode()",
				source: `${LIB} · L175`,
				detail: transient
					? "Bit 0 is set, so the reader answers from the word and never touches storage."
					: "Bit 0 is clear, so the reader ignores the word and returns the persistent flag. The library is invisible here.",
			},
			() => ({ read: true }),
		);

		record(
			{
				actor: "LibHook",
				call: "clearSignerForExternalCall()",
				source: `${LIB} · L216`,
				detail: transient
					? "The value is blanked and the marker is left standing. That pair — marker set, value empty — is the suspended signer state, and it is why the two slots exist separately."
					: "The persistent branch blanks <code>globalLayout.signer</code> instead, and the transient marker was never set.",
			},
			() => {
				if (state.signerActive) {
					state.heldSigner = state.signerValue;
					state.heldWasTransient = true;
					state.signerValue = ZERO_ADDRESS;
					return {};
				}
				state.heldSigner = state.persistentSigner;
				state.heldWasTransient = false;
				state.persistentSigner = ZERO_ADDRESS;
			},
		);

		record(
			{
				actor: "LibHook",
				call: "suspendExecutionContextForExternalCall()",
				source: `${LIB} · L261`,
				detail: transient
					? "Bit 255 marks a real snapshot, bit 254 records that transient storage owned the context, and bits 0-2 are copied across. The live word is then zeroed."
					: "With no live scope, the persistent branch builds the snapshot flag by flag — bit 255 plus one bit per mode field — and clears both fields. Bit 254 stays clear, which is the discriminator restore uses.",
			},
			() => {
				if (transient) {
					state.heldSnapshot = SNAPSHOT_ACTIVE | SNAPSHOT_TRANSIENT | state.context;
					state.context = 0n;
					return {};
				}
				let snapshot = SNAPSHOT_ACTIVE;
				if (state.persistentRouted) snapshot |= SNAPSHOT_PERSISTENT_CALL;
				if (state.persistentOpen) snapshot |= SNAPSHOT_PERSISTENT_OPEN;
				state.heldSnapshot = snapshot;
				state.persistentRouted = false;
				state.persistentOpen = false;
				return {};
			},
		);

		const hookNote = {
			clean: "The hook finds no outer batch authority. With no configured signer, <code>signer()</code> falls back to the hook's own <code>msg.sender</code> context; it cannot act as the hidden outer signer.",
			signer: "This models a privileged or re-entrant callback path leaving a signer installed while the outer signer is suspended. An ordinary hook fails at the setter's role gate.",
			scope: "This models a privileged or re-entrant callback path opening an InstantLayer scope and leaving it active. An ordinary hook fails at the setter's role gate.",
		};
		record(
			{
				actor: hook === "clean" ? "External hook" : "Privileged callback path",
				call:
					hook === "signer"
						? "setTransientSigner(0x…EE)"
						: hook === "scope"
							? "beginInstantLayerExecution(false)"
							: "isCallFromInstantLayer()",
				source: hook === "clean" ? `${LIB} · L158` : `${LIB} · ${hook === "signer" ? "L208" : "L124"}`,
				detail: hookNote[hook],
				untrusted: true,
			},
			() => {
				if (hook === "signer") {
					state.signerValue = ATTACKER_ADDRESS;
					state.signerActive = 1;
				}
				if (hook === "scope") state.context = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER;
			},
		);

		record(
			{
				actor: "LibHook",
				call: "restoreExecutionContextAfterExternalCall(snapshot)",
				source: `${LIB} · L286`,
				detail: transient
					? "One mask does the whole recovery: <code>snapshot & INSTANT_CONTEXT_FLAGS</code> keeps bits 0-2 and drops the two marker bits, which is exactly the word that was live before."
					: "Bit 254 is clear, so restore takes the persistent branch and rebuilds each field from its own bit.",
			},
			() => {
				const snapshot = state.heldSnapshot;
				if (snapshot === 0n) return { detail: "Nothing was suspended, so this is a no-op." };
				if ((snapshot & SNAPSHOT_ACTIVE) === 0n) return { revert: "ExternalCallContextNotSuspended" };
				if (state.context !== 0n || state.persistentRouted || state.persistentOpen) {
					return {
						revert: "ExternalCallContextWasModified",
						detail: "Restoration requires both context sources to be empty. Suspension cleared the active source, and entry guards required the inactive source to be empty already. Anything present now was installed by the hook, so restore fails closed.",
					};
				}
				if ((snapshot & SNAPSHOT_TRANSIENT) !== 0n) {
					state.context = snapshot & INSTANT_CONTEXT_FLAGS;
					return {};
				}
				state.persistentRouted = (snapshot & SNAPSHOT_PERSISTENT_CALL) !== 0n;
				state.persistentOpen = (snapshot & SNAPSHOT_PERSISTENT_OPEN) !== 0n;
			},
		);

		record(
			{
				actor: "LibHook",
				call: `restoreSignerAfterExternalCall(0x…D4, ${state.heldWasTransient})`,
				source: `${LIB} · L242`,
				detail: "Both branches refuse to restore on top of a populated signer layer. The transient branch checks the two value sources but not the marker, because balanced nested trusted signer use may legitimately have cleared that shared marker.",
			},
			() => {
				const branchTransient = state.heldWasTransient;
				if (branchTransient) {
					if (state.persistentSigner !== ZERO_ADDRESS || state.signerValue !== ZERO_ADDRESS) {
						return {
							revert: "ExternalCallSignerWasModified",
							detail: "The callback path left a signer in the transient value slot, so the guard fires and the whole transaction reverts. Authority cannot be smuggled across the boundary.",
						};
					}
					state.signerValue = state.heldSigner;
					state.signerActive = 1;
					return {};
				}
				if (state.persistentSigner !== ZERO_ADDRESS || state.signerActive || state.signerValue !== ZERO_ADDRESS) {
					return {
						revert: "ExternalCallSignerWasModified",
						detail: "The persistent branch also requires the marker to be clear: a set marker means the callback path opened a transient signer scope and left it active.",
					};
				}
				state.persistentSigner = state.heldSigner;
			},
		);

		if (transient) {
			record(
				{
					actor: "Authorized router",
					call: "setTransientSigner(address(0))",
					source: `${LIB} · L208`,
					detail: "Passing zero ends the override rather than masking anything: value and marker both go to zero.",
				},
				() => {
					state.signerValue = ZERO_ADDRESS;
					state.signerActive = 0;
				},
			);
			record(
				{
					actor: "InstantLayer",
					call: "endInstantLayerExecution()",
					source: `${LIB} · L137`,
					detail: "Two guards before the write: the scope must exist, and no signer may still be installed. Ending with one alive would leave an identity every later call still reads, with no scope to attribute it to.",
				},
				() => {
					if ((state.context & INSTANT_CONTEXT_ACTIVE) === 0n) return { revert: "TransientContextNotActive" };
					if (state.signerActive) return { revert: "TransientSignerNotCleared" };
					state.context = 0n;
				},
			);
		}
		return steps;
	};

	const readerRow = state => {
		const active = (state.context & INSTANT_CONTEXT_ACTIVE) !== 0n;
		const routed = active ? (state.context & CALL_FROM_INSTANT_LAYER) !== 0n : state.persistentRouted;
		const open = active ? (state.context & INSTANT_OPEN_MODE) !== 0n : state.persistentOpen;
		const signer = state.signerActive ? state.signerValue : state.persistentSigner;
		const item = (name, value, branch) => `
			<div class="bit-reader">
				<code>${name}</code>
				<strong class="${value === true ? "is-true" : value === false ? "is-false" : ""}">${value === true ? "true" : value === false ? "false" : value}</strong>
				<small>${branch}</small>
			</div>
		`;
		return `
			${item("isTransientContextActive()", active, "reads bit 0 only — never falls back")}
			${item("isCallFromInstantLayer()", routed, active ? "bit 0 set → answered from the word" : "bit 0 clear → persistent field")}
			${item("isInstantOpenMode()", open, active ? "bit 0 set → answered from the word" : "bit 0 clear → persistent field")}
			${item("configuredSigner()", signer === ZERO_ADDRESS ? "address(0)" : `${signer.slice(0, 6)}…${signer.slice(-4)}`, state.signerActive ? "marker set → transient value" : "marker clear → persistent field")}
		`;
	};

	const installLifecycleTool = mount => {
		let mechanism = "transient";
		let hook = "clean";
		let cursor = 0;
		let steps = buildLifecycle({ mechanism, hook });
		const headingId = "execution-context-lifecycle-tool-title";
		mount.setAttribute("aria-labelledby", headingId);
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">One batch lifecycle</p>
					<h4 id="${headingId}">From scope creation to final cleanup</h4>
				</div>
				<p>Deterministic example, no live transaction. Inspect intermediate states and changed slots. A rejected callback reverts the parent operation; later steps are not reached.</p>
			</div>
			<div class="bit-body">
				<div class="bit-controls">
					<label>Mechanism<select data-mechanism>
						<option value="transient">Transient</option>
						<option value="persistent">Persistent</option>
					</select></label>
					<label>Callback result<select data-hook>
						<option value="clean">Clean return</option>
						<option value="signer">Leaves signer</option>
						<option value="scope">Leaves scope</option>
					</select></label>
				</div>
				<p class="bit-reading">Transient models the current Cancun flow. Persistent models historical compatibility fields, not the runtime selector switch. Rejected examples represent privileged callback paths; ordinary hooks cannot pass the setter role gates.</p>
                <ol class="bit-timeline" role="list" aria-label="Lifecycle steps" data-timeline></ol>
				<div class="bit-stage">
					<div class="bit-stage-head">
						<div>
							<p class="bit-stage-actor" data-actor></p>
							<h4 data-call></h4>
							<p class="bit-stage-source" data-source></p>
						</div>
						<div class="bit-stage-nav">
							<button class="bit-chip" type="button" data-prev>Previous</button>
							<button class="bit-chip" type="button" data-next>Next</button>
						</div>
					</div>
					<p class="bit-stage-detail" data-detail role="status"></p>
					<div class="bit-slots" data-slots></div>
					<div class="bit-readers" data-readers></div>
				</div>
			</div>
		`;
		const timeline = mount.querySelector("[data-timeline]");
		const render = () => {
			const focused = document.activeElement;
			const focusedStep = timeline.contains(focused) ? focused.closest("[data-step]")?.dataset.step : null;
			const step = steps[cursor];
			timeline.innerHTML = steps
				.map(
					(entry, index) => `
							<li class="${index === cursor ? "is-current" : ""} ${entry.revert ? "is-revert" : ""} ${entry.skipped ? "is-skipped" : ""} ${entry.untrusted ? "is-untrusted" : ""}">
								<button type="button" data-step="${index}"${entry.skipped ? " disabled" : ""}${index === cursor ? ' aria-current="step"' : ""}>
								<small>${entry.skipped ? "Not reached" : entry.actor}</small>
								<span>${entry.revert ? "Reverts: " : ""}${formatCall(entry.call)}</span>
							</button>
						</li>
					`,
				)
				.join("");
			timeline.querySelectorAll("[data-step]").forEach(button => {
				button.addEventListener("click", () => {
					cursor = Number(button.dataset.step);
					render();
				});
			});
			mount.querySelector("[data-actor]").textContent = step.untrusted ? `${step.actor} · external code` : step.actor;
			mount.querySelector("[data-call]").innerHTML = `<code>${formatCall(step.call)}</code>`;
			mount.querySelector("[data-source]").innerHTML = step.skipped
				? "Not reached — the transaction already reverted."
				: escapeHtml(step.source);
			mount.querySelector("[data-detail]").innerHTML = step.revert
				? `<span class="bit-revert">revert ${step.revert}</span> ${step.detail}`
				: step.detail;
			const state = step.state;
			mount.querySelector("[data-slots]").innerHTML = `
				${renderWordCard(state.context, {
					label: "Context word",
					sublabel: "transient slot",
					changed: step.touched.context,
				})}
				${renderAddressWord(state.signerValue, { label: "Signer value", sublabel: "transient slot", changed: step.touched.signerValue })}
				${renderMarkerWord(state.signerActive, { label: "Signer marker", sublabel: "transient slot", changed: step.touched.signerActive })}
				${
					state.heldSnapshot
						? renderWordCard(state.heldSnapshot, { label: "Snapshot", sublabel: "held by the boundary", kind: "snapshot" })
						: `<div class="bit-word is-idle"><div class="bit-word-head"><span class="bit-word-name">Snapshot <small>held by the boundary</small></span><span class="bit-word-value"><code>0x00</code><small>nothing suspended</small></span></div><div class="bit-value-bar is-empty"><span>the 0 sentinel — restore treats it as a no-op</span></div></div>`
				}
				<div class="bit-word is-persistent ${step.touched.persistent ? "is-touched" : ""}">
					<div class="bit-word-head"><span class="bit-word-name">Persistent fields <small>GlobalAppStorage</small></span></div>
					<div class="bit-persistent-grid">
						<span class="${state.persistentRouted ? "is-set" : ""}">callFromInstantLayer <b>${state.persistentRouted}</b></span>
						<span class="${state.persistentOpen ? "is-set" : ""}">instantOpenMode <b>${state.persistentOpen}</b></span>
						<span class="${state.persistentSigner !== ZERO_ADDRESS ? "is-set" : ""}">signer <b>${state.persistentSigner === ZERO_ADDRESS ? "0x00" : `${state.persistentSigner.slice(0, 6)}…`}</b></span>
					</div>
				</div>
			`;
			mount.querySelector("[data-readers]").innerHTML = readerRow(state);
			// Reveal only the horizontal current-step card; keep the document's reading position.
			const selected = timeline.querySelector(".is-current");
			const cardBounds = selected.getBoundingClientRect();
			const rowBounds = timeline.getBoundingClientRect();
			if (cardBounds.left < rowBounds.left + 4) timeline.scrollLeft += cardBounds.left - rowBounds.left - 4;
			else if (cardBounds.right > rowBounds.right - 4) timeline.scrollLeft += cardBounds.right - rowBounds.right + 4;

			mount.querySelector("[data-prev]").disabled = cursor === 0;
			mount.querySelector("[data-next]").disabled = cursor === steps.length - 1 || Boolean(step.revert);
			if (focusedStep != null) {
				timeline.querySelector(`[data-step="${focusedStep}"]`)?.focus({ preventScroll: true });
			} else if (focused?.matches("[data-prev], [data-next]") && focused.disabled) {
				const alternative = mount.querySelector(focused.hasAttribute("data-next") ? "[data-prev]" : "[data-next]");
				if (!alternative.disabled) alternative.focus({ preventScroll: true });
				else timeline.querySelector(`[data-step="${cursor}"]`)?.focus({ preventScroll: true });
			}
		};
		const rebuild = () => {
			steps = buildLifecycle({ mechanism, hook });
			cursor = 0;
			render();
			timeline.scrollLeft = 0;
		};
		mount.querySelector("[data-mechanism]").addEventListener("change", event => {
			mechanism = event.target.value;
			rebuild();
		});
		mount.querySelector("[data-hook]").addEventListener("change", event => {
			hook = event.target.value;
			rebuild();
		});
		mount.querySelector("[data-prev]").addEventListener("click", () => {
			cursor = Math.max(0, cursor - 1);
			render();
		});
		mount.querySelector("[data-next]").addEventListener("click", () => {
			if (steps[cursor].revert) return;
			cursor = Math.min(steps.length - 1, cursor + 1);
			render();
		});
		render();
	};

	// ── Panel 3: caller-scoped snapshot slots ───────────────────────────────
	const CALLER_SLOTS = [
		{
			label: "InstantLayer",
			address: "0x00000000000000000000000000000000000000A1",
			hash: "0xf64e7f0ec8e8c5bc82bee2847b6f583c3266788aa4ca49817596356105c8e908",
		},
		{
			label: "AccountLayer",
			address: "0x00000000000000000000000000000000000000b2",
			hash: "0x9b44028ef3671c1336f18c6f5a960d1519535b02db4aab9563bfa42fc6280c56",
		},
		{
			label: "Affiliate hook",
			address: "0x00000000000000000000000000000000000000C3",
			hash: "0xa71ff9ed81d1e8da912df2c6027df0abc87b6cd03157fa2da42c61c15e1c5379",
		},
	];

	const installSlotAddressTool = mount => {
		const headingId = "execution-context-slot-tool-title";
		mount.setAttribute("aria-labelledby", headingId);
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Caller-scoped snapshot</p>
					<h4 id="${headingId}">Each router receives a separate saved-context slot</h4>
				</div>
				<p>Core combines one namespace with <code>msg.sender</code>; the same namespace and different callers derive unrelated slots.</p>
			</div>
			<div class="bit-body">
				<pre class="bit-code"><code>keccak256(abi.encode(<wbr>${formatSourceName("EXTERNAL_CALL_CONTEXT_NAMESPACE")}, caller))</code><small>${LIB} · L362</small></pre>
				<p class="bit-reading">The addresses are illustrative. Their different hashes are the isolation boundary between routers.</p>
				<div class="bit-slot-list">
					${CALLER_SLOTS.map(
						caller => `
							<div class="bit-slot">
								<div class="bit-slot-head"><code>${caller.label}</code><small>${caller.address}</small></div>
								<code class="is-wide">${caller.hash}</code>
							</div>
						`,
					).join("")}
				</div>
			</div>
		`;
	};

	const installBitLabTools = () => {
		document.querySelectorAll("[data-word-reader-tool]").forEach(installWordReaderTool);
		document.querySelectorAll("[data-context-lifecycle-tool]").forEach(installLifecycleTool);
		document.querySelectorAll("[data-slot-address-tool]").forEach(installSlotAddressTool);
	};

	installBitLabTools();
})();
