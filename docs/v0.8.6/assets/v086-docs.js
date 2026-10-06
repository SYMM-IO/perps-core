(() => {
	const root = document.documentElement;
	// Assets are resolved against this script rather than the page, so pages at any
	// depth (and the release indexes) reach the same shared vendor bundle.
	const scriptUrl = document.currentScript?.src || document.querySelector('script[src$="v086-docs.js"]')?.src || window.location.href;
	const assetUrl = path => new URL(path, scriptUrl).href;
	const themeStorage = {
		get() {
			try {
				return window.localStorage ? localStorage.getItem("v086-docs-theme") : null;
			} catch (_error) {
				return null;
			}
		},
		set(value) {
			try {
				if (window.localStorage) localStorage.setItem("v086-docs-theme", value);
			} catch (_error) {
				// File URLs and embedded browsers can deny storage; the visible toggle still works for this page load.
			}
		},
	};
	// One shared polite region for short confirmations (copy, calculator summaries).
	// Clearing first lets the same sentence be announced twice in a row.
	const liveStatus = document.createElement("p");
	liveStatus.className = "visually-hidden";
	liveStatus.setAttribute("role", "status");
	liveStatus.setAttribute("data-live-status", "");
	document.body.append(liveStatus);
	let liveStatusTimer = 0;
	window.v086Announce = text => {
		window.clearTimeout(liveStatusTimer);
		liveStatus.textContent = "";
		liveStatusTimer = window.setTimeout(() => {
			liveStatus.textContent = text;
		}, 60);
	};
	const announce = text => window.v086Announce(text);
	const themeButtons = Array.from(document.querySelectorAll("[data-theme-toggle]"));
	const icons = {
		check: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>',
		copy: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
		expand: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="M9 21H3v-6"/><path d="m3 21 7-7"/></svg>',
		close: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
		minus: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
		moon: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 7 7 0 1 0 20.5 14.5"/></svg>',
		plus: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
		sun: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/></svg>',
		wrap: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h14a4 4 0 0 1 0 8H7"/><path d="m10 12-3 3 3 3"/></svg>',
	};
	const setIconLabel = (element, icon, label) => {
		element.innerHTML = `${icon}<span>${label}</span>`;
	};
	const swapThemeWithoutTransitions = apply => {
		const guard = document.createElement("style");
		guard.textContent = "*,*::before,*::after{transition:none!important}";
		document.head.append(guard);
		apply();
		void root.offsetHeight;
		window.requestAnimationFrame(() => guard.remove());
	};

	const syncThemeButtons = () => {
		const isDark = root.dataset.theme === "dark";
		themeButtons.forEach(button => {
			setIconLabel(button, isDark ? icons.sun : icons.moon, isDark ? "Light theme" : "Dark theme");
			const actionLabel = isDark ? "Switch to light theme" : "Switch to dark theme";
			button.setAttribute("aria-label", actionLabel);
			button.setAttribute("title", actionLabel);
			button.removeAttribute("aria-pressed");
		});
	};
	const savedTheme = themeStorage.get();
	// Dark is the canonical Symmio surface; light is opt-in via the toggle.
	root.dataset.theme = savedTheme === "light" ? "light" : "dark";
	syncThemeButtons();

	themeButtons.forEach(button => {
		button.addEventListener("click", () => {
			const next = root.dataset.theme === "dark" ? "light" : "dark";
			swapThemeWithoutTransitions(() => {
				root.dataset.theme = next;
				themeStorage.set(next);
				syncThemeButtons();
			});
			window.dispatchEvent(new CustomEvent("v086-docs:themechange", { detail: { theme: next } }));
		});
	});

	const escapeHtml = value =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

	const detectDiagramType = source => {
		const first = source.trim().split(/\n/)[0] || "";
		if (/^sequenceDiagram/i.test(first)) return "sequence";
		if (/^(flowchart|graph)\b/i.test(first)) return "flow";
		if (/^stateDiagram/i.test(first)) return "state";
		if (/^gantt/i.test(first)) return "gantt";
		return "diagram";
	};

	const cleanNodeLabel = value => {
		const trimmed = value
			.replace(/["'`]/g, "")
			.replace(/<br\s*\/?>/gi, " / ")
			.replace(/\s+/g, " ")
			.trim();
		const bracket = trimmed.match(/^[\w.-]*[\[\(\{]([^()[\]{}]+)[\]\)\}]/);
		return (bracket ? bracket[1] : trimmed.replace(/^[\w.-]+$/, match => match)).replace(/&amp;/g, "&");
	};

	// Free text (messages, notes, branch conditions) keeps its brackets: only node
	// declarations such as `A[Label]` reduce to the bracketed label.
	const cleanText = value =>
		value
			.replace(/["'`]/g, "")
			.replace(/<br\s*\/?>/gi, " / ")
			.replace(/\s+/g, " ")
			.replace(/&amp;/g, "&")
			.trim();

	/* Sequence rows are messages, branch headers and notes, so the steps read in the
	   order the drawing does and alternatives read as alternatives. `rect` and `box`
	   blocks also close with `end` but carry no meaning in text, so they stay silent. */
	const SEQUENCE_BRANCH_PREFIX = {
		alt: "If",
		opt: "If",
		else: "Otherwise",
		loop: "Loop:",
		par: "In parallel:",
		and: "In parallel:",
		critical: "Critical:",
	};
	const SEQUENCE_BRANCH_END = {
		alt: "End of condition",
		opt: "End of condition",
		loop: "End of loop",
		par: "End of parallel block",
		critical: "End of critical block",
	};
	const parseSequence = source => {
		const rows = [];
		const open = [];
		// `participant FE as Front end` names the lane; rows use the name, not the id.
		const names = new Map();
		const nameOf = id => names.get(id.trim()) || cleanNodeLabel(id);
		source
			.split("\n")
			.map(line => line.trim())
			.forEach((line, index) => {
				const participant = line.match(/^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/);
				if (participant) {
					if (participant[2]) names.set(participant[1], cleanText(participant[2]));
					return;
				}
				const branch = line.match(/^(alt|else|opt|loop|par|and|critical)\b\s*(.*)$/);
				if (branch) {
					if (!["else", "and"].includes(branch[1])) open.push(branch[1]);
					const text = cleanText(branch[2]);
					rows.push({
						branch: text ? `${SEQUENCE_BRANCH_PREFIX[branch[1]]} ${text}` : SEQUENCE_BRANCH_PREFIX[branch[1]].replace(/:$/, ""),
						line: index,
					});
					return;
				}
				if (/^(rect|box)\b/.test(line)) {
					open.push(null);
					return;
				}
				if (/^end$/.test(line)) {
					const kind = open.pop();
					if (kind) rows.push({ branch: SEQUENCE_BRANCH_END[kind], end: true, line: index });
					return;
				}
				const note = line.match(/^Note (?:over|left of|right of) ([^:]+):\s*(.+)$/i);
				if (note) {
					rows.push({ note: cleanText(note[2]), about: note[1].split(",").map(nameOf).join(", "), line: index });
					return;
				}
				// Every message arrow: ->, -->, ->>, -->>, -x, --x, -) and --), with optional +/- activation.
				const message = line.match(/^([^-:]+?)\s*--?(?:>>|>|x|\))[+-]?\s*([^:]+?)\s*:\s*(.+)$/);
				if (message) rows.push({ from: nameOf(message[1]), to: nameOf(message[2]), label: cleanText(message[3]), line: index });
			});
		return rows;
	};

	/* Flow, state and gantt rows carry what the drawing carries: every edge (chains
	   and `&` groups expand to one row per pair), subgraph and composite-state
	   headings, notes, standalone nodes and gantt sections. Every parser's rows keep
	   the index of the source line they came from. */
	const cleanDiagramText = value =>
		value
			.replace(/^\s*"([\s\S]*)"\s*$/, "$1")
			.replace(/["`]/g, "")
			.replace(/<br\s*\/?>|\\n/gi, " ")
			.replace(/&amp;/g, "&")
			.replace(/\s+/g, " ")
			.trim();

	// Longest opener first, so `((` is not read as `(` and `[[` not as `[`.
	const FLOW_SHAPES = [
		["(((", [")))"]],
		["((", ["))"]],
		["([", ["])"]],
		["[[", ["]]"]],
		["[(", [")]"]],
		["[/", ["/]", "\\]"]],
		["[\\", ["\\]", "/]"]],
		["{{", ["}}"]],
		["(", [")"]],
		["[", ["]"]],
		["{", ["}"]],
		[">", ["]"]],
	];
	const readFlowNode = (text, start) => {
		const idMatch = /^\s*(\w+)/.exec(text.slice(start));
		if (!idMatch) return null;
		let end = start + idMatch[0].length;
		let label = null;
		const shape = FLOW_SHAPES.find(([opener]) => text.startsWith(opener, end));
		if (shape) {
			const bodyStart = end + shape[0].length;
			// A quoted label may contain the closing bracket, so search after the quote.
			const quote = /^\s*"/.exec(text.slice(bodyStart));
			const searchFrom = quote ? text.indexOf('"', bodyStart + quote[0].length) + 1 : bodyStart;
			if (quote && searchFrom === 0) return null;
			let close = -1;
			let closeLength = 0;
			shape[1].forEach(closer => {
				const at = text.indexOf(closer, searchFrom);
				if (at !== -1 && (close === -1 || at < close)) {
					close = at;
					closeLength = closer.length;
				}
			});
			if (close === -1) return null;
			label = cleanDiagramText(text.slice(bodyStart, close));
			end = close + closeLength;
		}
		return { id: idMatch[1], label, end };
	};
	const readFlowGroup = (text, start) => {
		const nodes = [];
		let end = start;
		for (;;) {
			const node = readFlowNode(text, end);
			if (!node) return null;
			nodes.push(node);
			end = node.end;
			const amp = /^\s*&/.exec(text.slice(end));
			if (!amp) return { nodes, end };
			end += amp[0].length;
		}
	};
	// Text-label forms (`-- a -->`, `-. a .->`, `== a ==>`) need spaces around the label,
	// which keeps them apart from the bare arrows that may carry `|label|`.
	const FLOW_LINKS = [
		/^\s*<?--\s+(.+?)\s+(?:-{2,}[>xo]|-{3,})/,
		/^\s*<?-\.\s+(.+?)\s+\.-[>xo]?/,
		/^\s*<?==\s+(.+?)\s+(?:={2,}[>xo]|={3,})/,
		/^\s*<?(?:-{2,}[>xo]|-{3,}|-\.+-[>xo]?|={2,}[>xo]|={3,}|~~~)(?:\s*\|([^|]*)\|)?/,
	];
	const readFlowLink = (text, start) => {
		const rest = text.slice(start);
		for (const pattern of FLOW_LINKS) {
			const match = pattern.exec(rest);
			if (match) return { label: cleanDiagramText(match[1] || ""), end: start + match[0].length };
		}
		return null;
	};
	const readFlowChain = line => {
		const first = readFlowGroup(line, 0);
		if (!first) return null;
		const groups = [first.nodes];
		const links = [];
		let end = first.end;
		for (;;) {
			const link = readFlowLink(line, end);
			if (!link) break;
			const next = readFlowGroup(line, link.end);
			if (!next) return null;
			links.push(link.label);
			groups.push(next.nodes);
			end = next.end;
		}
		return line.slice(end).replace(/;\s*$/, "").trim() ? null : { groups, links };
	};

	const parseFlow = source => {
		const labels = new Map();
		const statements = source.split("\n").map((raw, index) => {
			const line = raw.trim();
			if (!line || /^(flowchart|graph)\b/i.test(line) || /^(%%|style|classDef|class|linkStyle|click|direction)\b/.test(line)) return null;
			const subgraph = line.match(/^subgraph\s+(.+)$/);
			if (subgraph) {
				const titled = /^\s*"/.test(subgraph[1]) ? null : readFlowNode(subgraph[1], 0);
				const title = titled ? titled.label || titled.id : cleanDiagramText(subgraph[1]);
				return { index, subgraph: title };
			}
			if (/^end\s*;?$/.test(line)) return { index, end: true };
			const chain = readFlowChain(line);
			if (!chain) return null;
			chain.groups.flat().forEach(node => {
				if (node.label !== null) labels.set(node.id, node.label);
			});
			return { index, ...chain };
		});
		const linked = new Set();
		statements.forEach(statement => {
			if (statement?.links?.length) statement.groups.flat().forEach(node => linked.add(node.id));
		});
		// A node referenced by id alone reads as the label it was declared with anywhere.
		const labelOf = node => labels.get(node.id) ?? node.id;
		const rows = [];
		const open = [];
		statements.forEach(statement => {
			if (!statement) return;
			const line = statement.index;
			if ("subgraph" in statement) {
				open.push(statement.subgraph);
				rows.push({ branch: statement.subgraph, line });
			} else if (statement.end) {
				if (open.length) rows.push({ branch: `End of ${open.pop()}`, end: true, line });
			} else if (!statement.links.length) {
				// Declarations inside a subgraph show membership; loose ones only matter if no edge names them.
				statement.groups[0].forEach(node => {
					if (open.length || !linked.has(node.id)) rows.push({ node: labelOf(node), line });
				});
			} else {
				statement.links.forEach((label, step) => {
					statement.groups[step].forEach(from => {
						statement.groups[step + 1].forEach(to => rows.push({ from: labelOf(from), to: labelOf(to), label, line }));
					});
				});
			}
		});
		return rows;
	};

	const parseState = source => {
		const rows = [];
		const open = [];
		const names = new Map();
		// `[*]` is the start when it leads an arrow and the end when it closes one.
		const nameOf = (id, side) => (id === "[*]" ? (side === "from" ? "Start" : "End") : names.get(id) || cleanDiagramText(id));
		let note = null;
		source.split("\n").forEach((raw, index) => {
			const line = raw.trim();
			if (note) {
				if (/^end\s+note$/i.test(line)) {
					rows.push({ note: note.text.join(" "), about: note.about, line: note.line });
					note = null;
				} else if (line) note.text.push(cleanDiagramText(line));
				return;
			}
			if (!line || /^(stateDiagram|%%|classDef|class|direction|hide|style)\b/i.test(line)) return;
			const noteLine = line.match(/^note\s+(?:left|right)\s+of\s+(\S+)\s*(?::\s*(.*))?$/i);
			if (noteLine) {
				const about = nameOf(noteLine[1]);
				if (noteLine[2] !== undefined) rows.push({ note: cleanDiagramText(noteLine[2]), about, line: index });
				else note = { about, text: [], line: index };
				return;
			}
			const composite = line.match(/^state\s+(?:"([^"]+)"\s+as\s+)?(\S+?)\s*\{$/);
			if (composite) {
				if (composite[1]) names.set(composite[2], cleanDiagramText(composite[1]));
				const title = nameOf(composite[2]);
				open.push(title);
				rows.push({ branch: title, line: index });
				return;
			}
			if (line === "}") {
				if (open.length) rows.push({ branch: `End of ${open.pop()}`, end: true, line: index });
				return;
			}
			const alias = line.match(/^state\s+"([^"]+)"\s+as\s+(\S+)$/);
			if (alias) {
				names.set(alias[2], cleanDiagramText(alias[1]));
				rows.push({ node: names.get(alias[2]), line: index });
				return;
			}
			const transition = line.match(/^(\S+?)\s*-->\s*([^:]+?)\s*(?::\s*(.*))?$/);
			if (transition) {
				rows.push({
					from: nameOf(transition[1], "from"),
					to: nameOf(transition[2], "to"),
					label: cleanDiagramText(transition[3] || ""),
					line: index,
				});
				return;
			}
			const description = line.match(/^([\w.-]+)\s*:\s*(.+)$/);
			if (description) rows.push({ note: cleanDiagramText(description[2]), about: nameOf(description[1]), line: index });
		});
		return rows;
	};

	const formatDuration = seconds => {
		const rounded = Math.max(0, Math.round(seconds));
		const hours = Math.floor(rounded / 3600);
		const minutes = Math.floor((rounded % 3600) / 60);
		const remainingSeconds = rounded % 60;
		const parts = [];
		if (hours) parts.push(`${hours}h`);
		if (minutes) parts.push(`${minutes}m`);
		if (remainingSeconds || !parts.length) parts.push(`${remainingSeconds}s`);
		return parts.join(" ");
	};
	const GANTT_TAGS = new Set(["done", "active", "crit", "milestone"]);
	const parseGantt = source => {
		const rows = [];
		source.split("\n").forEach((raw, index) => {
			const line = raw.trim();
			if (!line || /^(gantt|title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|%%)\b/i.test(line)) return;
			const section = line.match(/^section\s+(.+)$/i);
			if (section) {
				rows.push({ branch: cleanDiagramText(section[1]), line: index });
				return;
			}
			const colon = line.indexOf(":");
			if (colon === -1) return;
			// Tasks read as a time range in the tools' own "T + ..." form. Mermaid's
			// status tags are styling, and every v0.8.6 gantt uses `dateFormat X` (seconds).
			const parts = line
				.slice(colon + 1)
				.split(",")
				.map(part => part.trim())
				.filter(Boolean);
			const milestone = parts.includes("milestone");
			const spec = parts.filter(part => !GANTT_TAGS.has(part));
			const numbers = spec.every(part => /^\d+(\.\d+)?$/.test(part)) ? spec.map(Number) : [];
			const [start, end] = numbers.length >= 2 ? numbers.slice(-2) : numbers;
			const timing =
				start === undefined
					? cleanDiagramText(spec.join(", "))
					: milestone || end === undefined || end === start
						? `At T + ${formatDuration(start)}`
						: `T + ${formatDuration(start)} to T + ${formatDuration(end)}`;
			rows.push({ label: cleanDiagramText(line.slice(0, colon)), timing, line: index });
		});
		return rows;
	};

	/* The text fallback stands in for a diagram that could not be drawn, so it may
	   not quietly end early. Long diagrams collapse past a readable length and say
	   exactly how many rows are hidden, with the full source one click away. */
	const FALLBACK_VISIBLE_ROWS = 18;
	const appendFallbackOverflow = (target, hidden, source) => {
		if (hidden <= 0) return;
		const notice = document.createElement("div");
		notice.className = "diagram-overflow";
		const count = document.createElement("span");
		count.textContent = `${hidden} more ${hidden === 1 ? "row" : "rows"} not shown`;
		const reveal = document.createElement("button");
		reveal.type = "button";
		reveal.textContent = "Show diagram source";
		reveal.addEventListener("click", () => {
			const existing = target.querySelector(".diagram-source");
			if (existing) {
				existing.remove();
				reveal.textContent = "Show diagram source";
				return;
			}
			const block = document.createElement("pre");
			block.className = "diagram-source";
			block.textContent = source.trim();
			target.append(block);
			reveal.textContent = "Hide diagram source";
		});
		notice.append(count, reveal);
		target.append(notice);
	};

	const fillFallbackDiagram = (target, source, limit = FALLBACK_VISIBLE_ROWS) => {
		const type = detectDiagramType(source);
		target.className = `diagram-fallback diagram-fallback-${type}`;
		target.replaceChildren();

		const parse = { sequence: parseSequence, state: parseState, gantt: parseGantt }[type] || parseFlow;
		const rows = parse(source);
		let stepNumber = 0;
		rows.slice(0, limit).forEach(step => {
			const row = document.createElement("div");
			if ("branch" in step) {
				row.className = step.end ? "diagram-branch is-end" : "diagram-branch";
				row.textContent = step.branch;
			} else if ("note" in step) {
				row.className = "diagram-note";
				// Reads "Lane: note", indented under the step it annotates.
				row.textContent = `${step.about}: ${step.note}`;
			} else if ("node" in step) {
				row.className = "diagram-edge";
				row.innerHTML = `<span class="diagram-node">${escapeHtml(step.node)}</span>`;
			} else if ("timing" in step) {
				row.className = "diagram-task";
				row.innerHTML = `<strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.timing)}</small>`;
			} else if (type === "sequence") {
				stepNumber += 1;
				row.className = "diagram-step";
				row.innerHTML = `<span class="diagram-count">${String(stepNumber).padStart(2, "0")}</span><span class="diagram-node">${escapeHtml(step.from)}</span><span class="diagram-arrow">to</span><span class="diagram-node">${escapeHtml(step.to)}</span><span class="diagram-message">${escapeHtml(step.label)}</span>`;
			} else {
				row.className = "diagram-edge";
				row.innerHTML = `<span class="diagram-node">${escapeHtml(step.from)}</span><span class="diagram-arrow">${escapeHtml(step.label || "to")}</span><span class="diagram-node">${escapeHtml(step.to)}</span>`;
			}
			target.append(row);
		});
		appendFallbackOverflow(target, rows.length - limit, source);
	};

	let activeDiagramModal = null;
	const openDiagramViewer = (frame, title) => {
		if (activeDiagramModal) activeDiagramModal.remove();

		const source = frame.querySelector(":scope > .mermaid, :scope > .diagram-fallback");
		if (!source) return;
		const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
		const helpText = coarsePointer ? "Pinch to zoom, drag to pan" : "Scroll to zoom, drag or use arrow keys to pan";

		const modal = document.createElement("div");
		modal.className = "diagram-modal";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-label", `${title} diagram viewer`);
		modal.innerHTML = `
			<div class="diagram-modal-bar">
				<strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
				<span class="diagram-modal-help">${helpText}</span>
				<div class="diagram-modal-actions">
					<button type="button" data-diagram-zoom="out" aria-label="Zoom out">${icons.minus}</button>
					<button type="button" data-diagram-zoom="in" aria-label="Zoom in">${icons.plus}</button>
					<output class="diagram-zoom-level">100%</output>
					<button type="button" data-diagram-zoom="reset">Fit to width</button>
					<button type="button" data-diagram-close aria-label="Close diagram">${icons.close}<span>Close</span></button>
				</div>
			</div>
			<div class="diagram-modal-stage">
				<div class="diagram-modal-canvas"></div>
			</div>
		`;

		const stage = modal.querySelector(".diagram-modal-stage");
		const canvas = modal.querySelector(".diagram-modal-canvas");
		stage.tabIndex = 0;
		stage.setAttribute("role", "region");
		stage.setAttribute("aria-label", "Diagram canvas. Arrow keys pan, plus and minus zoom, 0 fits.");
		const modalSource = source.cloneNode(true);
		// The inline canvas is only a pointer shortcut; nothing in the clone is a control.
		["role", "tabindex", "aria-label"].forEach(attribute => modalSource.removeAttribute?.(attribute));
		const modalSvg = modalSource.matches?.("svg") ? modalSource : modalSource.querySelector?.("svg");
		if (modalSvg) namespaceSvgIds(modalSvg, `diagram-modal-${Date.now()}`);
		canvas.append(modalSource);
		document.body.append(modal);
		document.body.classList.add("has-diagram-modal");
		activeDiagramModal = modal;

		let scale = 1;
		let x = 0;
		let y = 0;
		let dragging = false;
		let startX = 0;
		let startY = 0;
		let originX = 0;
		let originY = 0;
		let dragMoved = false;
		let pinched = false;
		let lastDragEndedAt = 0;
		let backdropClickCandidate = false;
		let backdropStartX = 0;
		let backdropStartY = 0;
		const pointers = new Map();
		const backdropClickThreshold = 6;
		const diagramContentSelector = ".diagram-modal-canvas > .mermaid, .diagram-modal-canvas > .diagram-fallback";
		const zoomLevel = modal.querySelector(".diagram-zoom-level");
		const resetZoomButton = modal.querySelector('[data-diagram-zoom="reset"]');
		const minScale = 0.35;
		const maxScale = 4;
		const fitPadding = 40;
		const applyTransform = () => {
			canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
			if (zoomLevel) zoomLevel.textContent = `${Math.round(scale * 100)}%`;
		};
		const clampScale = value => Math.min(maxScale, Math.max(minScale, Number(value.toFixed(3))));
		const fitToStage = () => {
			const stageRect = stage.getBoundingClientRect();
			const contentWidth = canvas.offsetWidth;
			const contentHeight = canvas.offsetHeight;
			if (!contentWidth || !contentHeight) return;
			const narrow = stageRect.width < 640;
			const padding = narrow ? 16 : fitPadding;
			const availableWidth = Math.max(1, stageRect.width - padding * 2);
			const availableHeight = Math.max(1, stageRect.height - padding * 2);
			// Fit to a readable scale: grow small diagrams on wide stages, and keep a
			// floor on phones so labels stay legible. Wider content starts at its left
			// edge and pans; tall content starts at the top.
			const widthFit = availableWidth / contentWidth;
			const readableFloor = narrow ? 0.8 : 0;
			scale = clampScale(Math.min(1.6, Math.max(widthFit, readableFloor)));
			// On phones the readable floor can win over fitting, so say what the button really does.
			if (resetZoomButton) resetZoomButton.textContent = widthFit < readableFloor ? "Reset view" : "Fit to width";
			x = contentWidth * scale <= availableWidth ? (stageRect.width - contentWidth * scale) / 2 : padding;
			y = contentHeight * scale <= availableHeight ? (stageRect.height - contentHeight * scale) / 2 : padding;
			applyTransform();
		};
		const stageCenter = () => {
			const rect = stage.getBoundingClientRect();
			return {
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
			};
		};
		const zoomTo = (nextScale, anchor = stageCenter()) => {
			nextScale = clampScale(nextScale);
			if (nextScale === scale) return;
			const stageRect = stage.getBoundingClientRect();
			const anchorX = anchor.clientX - stageRect.left;
			const anchorY = anchor.clientY - stageRect.top;
			const localX = (anchorX - canvas.offsetLeft - x) / scale;
			const localY = (anchorY - canvas.offsetTop - y) / scale;
			x = anchorX - canvas.offsetLeft - localX * nextScale;
			y = anchorY - canvas.offsetTop - localY * nextScale;
			scale = nextScale;
			applyTransform();
		};
		const zoomBy = (factor, anchor) => zoomTo(scale * factor, anchor);
		const reset = () => fitToStage();
		const focusableSelector = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
		const close = () => {
			modal.remove();
			document.body.classList.remove("has-diagram-modal");
			if (activeDiagramModal === modal) activeDiagramModal = null;
			document.removeEventListener("keydown", onKeydown);
			window.removeEventListener("resize", fitToStage);
			if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
		};
		const panSteps = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
		const onStageKey = event => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const pan = panSteps[event.key];
			if (pan) {
				event.preventDefault();
				const step = event.shiftKey ? 160 : 48;
				x += pan[0] * step;
				y += pan[1] * step;
				applyTransform();
			} else if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				zoomBy(1.18);
			} else if (event.key === "-" || event.key === "_") {
				event.preventDefault();
				zoomBy(1 / 1.18);
			} else if (event.key === "0") {
				event.preventDefault();
				reset();
			}
		};
		const onKeydown = event => {
			if (event.key === "Escape") {
				close();
				return;
			}
			if (document.activeElement === stage) onStageKey(event);
			if (event.key === "Tab") {
				const focusable = Array.from(modal.querySelectorAll(focusableSelector)).filter(
					element => !element.hasAttribute("disabled") && element instanceof HTMLElement,
				);
				if (!focusable.length) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		};

		modal.querySelector("[data-diagram-close]").addEventListener("click", close);
		modal.querySelector("[data-diagram-zoom='in']").addEventListener("click", () => zoomBy(1.18));
		modal.querySelector("[data-diagram-zoom='out']").addEventListener("click", () => zoomBy(1 / 1.18));
		modal.querySelector("[data-diagram-zoom='reset']").addEventListener("click", reset);
		modal.addEventListener("click", event => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (Date.now() - lastDragEndedAt < 200) return;
			if (target.closest(`${diagramContentSelector}, .diagram-modal-bar`)) return;
			close();
		});
		stage.addEventListener(
			"wheel",
			event => {
				event.preventDefault();
				const normalizedDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
				const boundedDelta = Math.max(-220, Math.min(220, normalizedDelta));
				const factor = Math.exp(-boundedDelta * 0.0007);
				zoomBy(factor, { clientX: event.clientX, clientY: event.clientY });
			},
			{ passive: false },
		);
		const beginDrag = point => {
			dragging = true;
			startX = point.clientX;
			startY = point.clientY;
			originX = x;
			originY = y;
			stage.classList.add("is-dragging");
		};
		const pointerDistance = () => {
			const [a, b] = Array.from(pointers.values());
			return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
		};
		stage.addEventListener("pointerdown", event => {
			if (event.button !== 0) return;
			event.preventDefault();
			stage.focus({ preventScroll: true });
			stage.setPointerCapture(event.pointerId);
			pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
			if (pointers.size === 1) {
				backdropClickCandidate = event.target instanceof Element && !event.target.closest(diagramContentSelector);
				backdropStartX = event.clientX;
				backdropStartY = event.clientY;
				dragMoved = false;
				pinched = false;
				beginDrag(event);
				return;
			}
			// A second finger turns the gesture into a pinch.
			pinched = true;
			dragging = false;
			backdropClickCandidate = false;
		});
		stage.addEventListener("pointermove", event => {
			if (!pointers.has(event.pointerId)) return;
			event.preventDefault();
			if (pointers.size >= 2) {
				const before = pointerDistance();
				pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
				const after = pointerDistance();
				const [a, b] = Array.from(pointers.values());
				if (before > 0 && after > 0) zoomBy(after / before, { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
				return;
			}
			pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
			if (!dragging) return;
			const dragDistance = Math.hypot(event.clientX - backdropStartX, event.clientY - backdropStartY);
			if (dragDistance > backdropClickThreshold) {
				dragMoved = true;
				backdropClickCandidate = false;
			}
			x = originX + event.clientX - startX;
			y = originY + event.clientY - startY;
			applyTransform();
		});
		const stopDragging = event => {
			pointers.delete(event.pointerId);
			if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
			if (pointers.size === 1) {
				// One finger left after a pinch keeps panning from where it is.
				beginDrag(Array.from(pointers.values())[0]);
				return;
			}
			if (pointers.size > 1) return;
			const shouldCloseFromBackdrop = backdropClickCandidate && !dragMoved && !pinched;
			if (dragMoved || pinched) lastDragEndedAt = Date.now();
			backdropClickCandidate = false;
			dragMoved = false;
			pinched = false;
			dragging = false;
			stage.classList.remove("is-dragging");
			if (shouldCloseFromBackdrop) close();
		};
		stage.addEventListener("pointerup", stopDragging);
		stage.addEventListener("pointercancel", stopDragging);
		document.addEventListener("keydown", onKeydown);
		window.addEventListener("resize", fitToStage);
		modal.querySelector("[data-diagram-close]").focus();
		fitToStage();
	};

	const namespaceSvgIds = (svg, namespace) => {
		const idMap = new Map();
		svg.querySelectorAll("[id]").forEach((node, index) => {
			if (node === svg) return;
			const previous = node.id;
			const next = `${namespace}-${index}-${previous}`;
			idMap.set(previous, next);
			node.id = next;
		});
		if (!idMap.size) return;
		const referenceAttributes = [
			"aria-describedby",
			"aria-labelledby",
			"clip-path",
			"fill",
			"filter",
			"href",
			"marker-end",
			"marker-mid",
			"marker-start",
			"mask",
			"stroke",
			"xlink:href",
		];
		svg.querySelectorAll("*").forEach(node => {
			referenceAttributes.forEach(attribute => {
				const value = node.getAttribute(attribute);
				if (!value) return;
				let nextValue = value;
				idMap.forEach((next, previous) => {
					nextValue = nextValue.replaceAll(`url(#${previous})`, `url(#${next})`);
					if (nextValue === `#${previous}`) nextValue = `#${next}`;
					if (attribute.startsWith("aria-")) {
						nextValue = nextValue
							.split(/\s+/)
							.map(token => (token === previous ? next : token))
							.join(" ");
					}
				});
				if (nextValue !== value) node.setAttribute(attribute, nextValue);
			});
		});
	};

	const enhanceMermaidSvg = (svg, namespace) => {
		if (!svg) return;
		namespaceSvgIds(svg, namespace);
		const softenRect = (rect, radius) => {
			const rx = rect.getAttribute("rx");
			const ry = rect.getAttribute("ry");
			if (!rx || rx === "0") rect.setAttribute("rx", radius);
			if (!ry || ry === "0") rect.setAttribute("ry", radius);
		};
		svg.dataset.styled = "true";
		svg.querySelectorAll(".node, .state, .actor").forEach(node => {
			node.querySelectorAll("rect").forEach(rect => softenRect(rect, "6"));
		});
		svg.querySelectorAll(".cluster rect, .note, .labelBox, .edgeLabel rect").forEach(rect => softenRect(rect, "5"));
	};

	const TYPE_LABELS = { sequence: "Sequence", flow: "Flow", state: "State", gantt: "Timeline", diagram: "Diagram" };

	/* A caption names what the figure shows, not which Mermaid grammar drew it.
	   An authored `data-diagram-title` wins; otherwise the section the diagram sits
	   in supplies the subject, and the grammar becomes a trailing qualifier. */
	const describeDiagram = (pre, code, source) => {
		const type = detectDiagramType(source);
		const typeLabel = TYPE_LABELS[type] || TYPE_LABELS.diagram;
		const authored = (code.dataset.diagramTitle || pre?.dataset.diagramTitle || "").trim();
		if (authored) return { type, text: authored };

		let node = pre;
		while (node && node !== document.body) {
			let sibling = node.previousElementSibling;
			while (sibling) {
				if (/^H[2-6]$/.test(sibling.tagName)) {
					const heading = sibling.cloneNode(true);
					heading.querySelectorAll(".heading-anchor").forEach(button => button.remove());
					const title = (heading.textContent || "")
						.replace(/#$/, "")
						.replace(/^\d+(\.\d+)*\.?\s*/, "")
						.trim();
					// An unrecognised grammar adds nothing to the caption, so drop the qualifier.
					if (title) return { type, text: type === "diagram" ? title : `${title}: ${typeLabel.toLowerCase()}` };
				}
				sibling = sibling.previousElementSibling;
			}
			node = node.parentElement;
		}
		return { type, text: typeLabel };
	};

	/* Mermaid ships with the docs rather than loading from a CDN, so diagrams also
	   draw offline, from a file:// checkout, and behind a proxy. Loaded once, lazily,
	   and only on pages that actually contain a diagram. */
	let mermaidPromise = null;
	const loadMermaid = () => {
		if (window.mermaid) return Promise.resolve(window.mermaid);
		if (mermaidPromise) return mermaidPromise;
		mermaidPromise = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = assetUrl("../../assets/vendor/mermaid.min.js");
			script.addEventListener("load", () =>
				window.mermaid ? resolve(window.mermaid) : reject(new Error("mermaid bundle loaded but exported nothing")),
			);
			script.addEventListener("error", () => reject(new Error("mermaid bundle could not be loaded")));
			document.head.append(script);
		});
		return mermaidPromise;
	};

	/* Mermaid colors come from the same tokens as the rest of the page, read at
	   render time so a theme switch can redraw with the new values. The hex set
	   is only a fallback for a token that resolves to nothing. */
	const MERMAID_FALLBACK_THEME = {
		dark: {
			background: "#050505",
			node: "#1c100e",
			nodeBorder: "#ff7c70",
			ink: "#f2eded",
			label: "#141010",
			cluster: "#121010",
			border: "#4a4646",
			edge: "#8f8a8a",
		},
		light: {
			background: "#ffffff",
			node: "#fff1ef",
			nodeBorder: "#e0483a",
			ink: "#0a0a0a",
			label: "#ffffff",
			cluster: "#fafafa",
			border: "#bdbdbd",
			edge: "#6f6f6f",
		},
	};
	const resolveTokenColor = (probe, token, fallback) => {
		const raw = getComputedStyle(root).getPropertyValue(token).trim();
		if (!raw) return fallback;
		probe.style.color = "";
		probe.style.color = raw;
		if (!probe.style.color) return fallback;
		// Computed style normalises hsl() to rgb()/rgba(), which mermaid's color math parses.
		return getComputedStyle(probe).color || fallback;
	};
	const diagramFont = () => {
		const styles = getComputedStyle(document.documentElement);
		return {
			fontFamily: styles.getPropertyValue("--diagram-font").trim() || "Inter, ui-sans-serif, system-ui, sans-serif",
			fontSize: styles.getPropertyValue("--diagram-font-size").trim() || "14px",
		};
	};

	const buildMermaidTheme = () => {
		const fallback = MERMAID_FALLBACK_THEME[root.dataset.theme === "light" ? "light" : "dark"];
		const probe = document.createElement("span");
		probe.hidden = true;
		document.body.append(probe);
		const color = (token, key) => resolveTokenColor(probe, token, fallback[key]);
		const background = color("--diagram-bg", "background");
		const node = color("--diagram-node", "node");
		const nodeBorder = color("--diagram-node-border", "nodeBorder");
		const ink = color("--ink", "ink");
		const label = color("--diagram-label-bg", "label");
		const cluster = color("--diagram-cluster", "cluster");
		const border = color("--line-strong", "border");
		const edge = color("--diagram-edge", "edge");
		const { fontFamily, fontSize } = diagramFont();
		probe.remove();
		return {
			fontFamily,
			fontSize,
			background,
			mainBkg: node,
			primaryColor: node,
			primaryBorderColor: nodeBorder,
			primaryTextColor: ink,
			secondaryColor: label,
			secondaryBorderColor: border,
			secondaryTextColor: ink,
			tertiaryColor: cluster,
			tertiaryBorderColor: border,
			tertiaryTextColor: ink,
			lineColor: edge,
			textColor: ink,
			nodeTextColor: ink,
			clusterBkg: cluster,
			clusterBorder: border,
			edgeLabelBackground: label,
			actorBkg: node,
			actorBorder: nodeBorder,
			actorTextColor: ink,
			actorLineColor: edge,
			noteBkgColor: label,
			noteTextColor: ink,
			noteBorderColor: border,
			labelBoxBkgColor: label,
			labelBoxBorderColor: border,
			labelTextColor: ink,
			loopTextColor: ink,
		};
	};

	/* Authored `data-diagram-size="W H"` on a mermaid `pre` is the drawing's natural
	   size. The loading box reserves the height the drawing will take, so the page
	   does not shift when it arrives: from 641px up the SVG shrinks to the frame,
	   below that it keeps at least 720px and scrolls sideways. */
	const parseDiagramSize = pre => {
		const [width, height] = (pre?.dataset.diagramSize || "").trim().split(/\s+/).map(Number);
		return width > 0 && height > 0 ? { width, height } : null;
	};
	const expectDiagramHeight = (canvas, { width, height }) => {
		const style = getComputedStyle(canvas);
		const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
		const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
		const contentWidth = canvas.clientWidth - paddingX;
		const phone = window.matchMedia("(max-width: 640px)").matches;
		const renderedWidth = phone ? Math.max(720, width) : Math.min(width, contentWidth);
		return Math.ceil((renderedWidth * height) / width + paddingY);
	};

	const installMermaidDiagrams = async () => {
		const blocks = Array.from(document.querySelectorAll(".doc-article pre > code.language-mermaid"));
		if (!blocks.length) return;

		const diagrams = blocks.map((code, index) => {
			const source = code.textContent || "";
			const pre = code.closest("pre");
			const frame = document.createElement("figure");
			frame.className = "mermaid-frame";
			const caption = document.createElement("figcaption");
			const captionText = describeDiagram(pre, code, source).text;
			const captionLabel = document.createElement("span");
			captionLabel.textContent = captionText;
			const openButton = document.createElement("button");
			openButton.type = "button";
			openButton.className = "diagram-open-button";
			setIconLabel(openButton, icons.expand, "Full screen");
			openButton.setAttribute("aria-label", `Open ${captionText} diagram full screen`);
			const openDiagram = () => openDiagramViewer(frame, captionText);
			openButton.addEventListener("click", openDiagram);
			caption.append(captionLabel, openButton);
			// Clicking the drawing is a pointer shortcut; the Full screen button above
			// is the one control keyboard and screen reader users need.
			const canvas = document.createElement("div");
			canvas.className = "diagram-fallback is-loading";
			canvas.dataset.diagramIndex = String(index);
			canvas.textContent = "Drawing diagram…";
			canvas.addEventListener("click", event => {
				if (event.target.closest("button, a")) return;
				openDiagram();
			});
			frame.append(caption, canvas);
			const size = parseDiagramSize(pre);
			if (pre) pre.replaceWith(frame);
			return { frame, canvas, captionLabel, source, size, expectedHeight: 0 };
		});
		// Measure every placeholder first, then write, so the page lays out once.
		diagrams.forEach(diagram => {
			if (diagram.size) diagram.expectedHeight = expectDiagramHeight(diagram.canvas, diagram.size);
		});
		diagrams.forEach(({ canvas, expectedHeight }) => {
			if (expectedHeight) canvas.style.setProperty("--diagram-h", `${expectedHeight}px`);
		});

		const showFallback = ({ frame, canvas, captionLabel, source }) => {
			frame.classList.add("is-fallback");
			// The fallback already is the text version; drop the twin so it is not shown twice.
			frame.querySelector(":scope > .diagram-steps")?.remove();
			fillFallbackDiagram(canvas, source);
			if (frame.querySelector(".diagram-fallback-note")) return;
			const note = document.createElement("span");
			note.className = "diagram-fallback-note";
			note.textContent = "Text version, diagram could not be drawn";
			captionLabel.after(note);
		};

		const appendStepsTwin = ({ frame, source }) => {
			if (frame.querySelector(":scope > .diagram-steps")) return;
			const steps = document.createElement("details");
			steps.className = "diagram-steps";
			const summary = document.createElement("summary");
			summary.textContent = "View as steps";
			const list = document.createElement("div");
			// The twin is the complete text equivalent, so it never truncates.
			fillFallbackDiagram(list, source, Infinity);
			steps.append(summary, list);
			frame.append(steps);
		};
		// Built with the frame, not after drawing, so the row below never shifts the page.
		diagrams.forEach(appendStepsTwin);

		const renderDiagrams = async mermaid => {
			const { fontFamily, fontSize } = diagramFont();
			// Mermaid sizes every box from measured text, so the face must be loaded first
			// or labels are laid out in the fallback font and then drawn in the real one.
			try {
				await Promise.all(["400", "600"].map(weight => document.fonts.load(`${weight} ${fontSize} ${fontFamily}`)));
			} catch (_error) {}
			const size = Number.parseFloat(fontSize) || 14;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "loose",
				theme: "base",
				fontFamily,
				fontSize: size,
				themeVariables: buildMermaidTheme(),
				flowchart: { htmlLabels: true },
				sequence: {
					actorFontFamily: fontFamily,
					actorFontSize: size,
					messageFontFamily: fontFamily,
					messageFontSize: size,
					noteFontFamily: fontFamily,
					noteFontSize: size,
				},
				gantt: { fontSize: size, sectionFontSize: size },
			});
			const staging = document.createElement("div");
			staging.className = "mermaid-staging";
			document.body.append(staging);
			const renderNodes = diagrams.map(({ source }, index) => {
				const node = document.createElement("div");
				node.className = "mermaid";
				node.id = `mermaid-render-${Date.now()}-${index}`;
				node.textContent = source;
				staging.append(node);
				return node;
			});
			try {
				await mermaid.run({ nodes: renderNodes, suppressErrors: true });
				renderNodes.forEach((node, index) => {
					const diagram = diagrams[index];
					const svg = node.querySelector("svg");
					if (svg) {
						const renderedSvg = svg.cloneNode(true);
						enhanceMermaidSvg(renderedSvg, `diagram-${index}`);
						diagram.canvas.className = "mermaid";
						diagram.canvas.replaceChildren(renderedSvg);
						// Phones size the SVG to at least its natural width so labels keep their authored size.
						const naturalWidth = renderedSvg.viewBox?.baseVal?.width;
						if (naturalWidth) renderedSvg.style.setProperty("--diagram-natural-width", `${Math.ceil(naturalWidth)}px`);
						if (diagram.expectedHeight) {
							diagram.canvas.style.removeProperty("--diagram-h");
							const actualHeight = diagram.canvas.getBoundingClientRect().height;
							// Checked once per diagram, on first draw; theme redraws skip it.
							if (Math.abs(actualHeight - diagram.expectedHeight) > 40) {
								console.debug(
									`Diagram ${index + 1} rendered ${Math.round(actualHeight)}px tall, its data-diagram-size predicted ${diagram.expectedHeight}px; update the attribute.`,
								);
							}
							diagram.expectedHeight = 0;
						}
						diagram.frame.classList.add("is-rendered");
					} else if (!diagram.frame.classList.contains("is-rendered")) {
						// A redraw that fails keeps the drawing it already has.
						showFallback(diagram);
					}
				});
				// Wide drawings may now overflow their frame; make those reachable by keyboard.
				syncScrollRegions();
			} finally {
				staging.remove();
			}
		};

		let mermaid;
		try {
			mermaid = await loadMermaid();
			await renderDiagrams(mermaid);
		} catch (_error) {
			diagrams.forEach(diagram => {
				if (!diagram.frame.classList.contains("is-rendered")) showFallback(diagram);
			});
			if (!mermaid) return;
		}

		// Redraw with the new theme's tokens; queued so two quick toggles never overlap.
		let redraw = Promise.resolve();
		window.addEventListener("v086-docs:themechange", () => {
			redraw = redraw.then(() => renderDiagrams(mermaid)).catch(() => {});
		});
	};

	installMermaidDiagrams();

	const formatAmount = value =>
		new Intl.NumberFormat("en-US", { maximumFractionDigits: 6, minimumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
	// Returns null for a blank, non-numeric or out-of-range entry so the tool can say so
	// instead of computing with a silent 0 or a negative amount. `data-min-exclusive`
	// makes `min` itself invalid (an amount that must be above 0).
	const readChecked = input => {
		const text = input ? input.value.trim() : "";
		const value = Number(text);
		const min = input && input.getAttribute("min") !== null ? Number(input.getAttribute("min")) : 0;
		const max = input && input.getAttribute("max") !== null ? Number(input.getAttribute("max")) : Infinity;
		const belowMin = input?.hasAttribute("data-min-exclusive") ? value <= min : value < min;
		return text === "" || !Number.isFinite(value) || belowMin || value > max ? null : value;
	};
	const sentence = text => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

	let toolCount = 0;
	const nextToolId = () => `calc-${++toolCount}`;
	// The error text sits inside the label for layout, but is hidden from the label's
	// name and reached through aria-describedby instead, so it is read once.
	const toolInput = (id, label, attributes, error = "Enter 0 or more.") =>
		`<label>${label}<input id="${id}" ${attributes} aria-describedby="${id}-error"><small class="tool-field-error" id="${id}-error" aria-hidden="true" hidden>${error}</small></label>`;
	const resetButtonMarkup = '<button type="button" class="button ghost tool-reset">Reset example</button>';
	const setFieldInvalid = (control, invalid) => {
		if (invalid) control.setAttribute("aria-invalid", "true");
		else control.removeAttribute("aria-invalid");
		const message = control.parentElement?.querySelector(".tool-field-error");
		if (message) message.hidden = !invalid;
	};

	/* Shared calculator loop. `compute` returns { html, invalid, summary }:
	   `invalid` lists the controls whose entry cannot be used. While such a value is
	   being typed the last good result stays up, dimmed; the error and the field
	   marks appear on change (blur), on reset, or when there is nothing to keep. */
	const wireTool = (mount, result, compute) => {
		const controls = Array.from(mount.querySelectorAll("input, select"));
		let lastGood = "";
		let announceTimer = 0;
		const update = event => {
			const outcome = compute();
			const invalid = new Set(outcome.invalid || []);
			const typing = event?.type === "input";
			controls.forEach(control => {
				if (!invalid.has(control)) setFieldInvalid(control, false);
			});
			if (invalid.size && typing && lastGood) {
				result.classList.add("is-stale");
				return;
			}
			result.classList.remove("is-stale");
			result.innerHTML = outcome.html;
			if (invalid.size) {
				invalid.forEach(control => setFieldInvalid(control, true));
				lastGood = "";
				return;
			}
			lastGood = outcome.html;
			// Only after load: the scroll-region helper is set up further down the file.
			if (event) syncScrollRegions();
			if (event && outcome.summary) {
				window.clearTimeout(announceTimer);
				announceTimer = window.setTimeout(() => announce(outcome.summary), 500);
			}
		};
		const heading = mount.querySelector(".tool-heading");
		if (heading) {
			heading.insertAdjacentHTML("beforeend", resetButtonMarkup);
			heading.querySelector(".tool-reset").addEventListener("click", () => {
				controls.forEach(control => {
					if (control instanceof HTMLSelectElement) {
						const defaultIndex = Array.from(control.options).findIndex(option => option.defaultSelected);
						control.selectedIndex = defaultIndex >= 0 ? defaultIndex : 0;
					} else {
						control.value = control.defaultValue;
					}
					setFieldInvalid(control, false);
				});
				lastGood = "";
				update({ type: "reset" });
			});
		}
		controls.forEach(control => {
			control.addEventListener("input", update);
			control.addEventListener("change", update);
		});
		update();
	};
	// One sentence per rule, naming the fields that break it, in the words their own
	// field errors use.
	const fieldRule = input => {
		const min = input?.getAttribute("min") ?? "0";
		const max = input?.getAttribute("max");
		if (input?.hasAttribute("data-min-exclusive")) return `Enter an amount above ${min}`;
		return max !== null && max !== undefined ? `Enter ${min} to ${max}` : `Enter ${min} or more`;
	};
	const invalidValuesMessage = fields => {
		const groups = new Map();
		fields.forEach(field => {
			const rule = fieldRule(field.input);
			groups.set(rule, [...(groups.get(rule) || []), field.label]);
		});
		const items = Array.from(groups, ([rule, labels]) => `<li>${escapeHtml(`${rule} for ${labels.join(", ")}.`)}</li>`);
		return `<ul class="tool-warnings">${items.join("")}</ul>`;
	};

	const installExpressFundingTool = mount => {
		const uid = nextToolId();
		const money = (name, label, value, error, extra = "") =>
			toolInput(`${uid}-${name}`, label, `type="text" inputmode="decimal" min="0"${extra} value="${value}" data-${name}`, error);
		const count = (name, label, value, max = "") =>
			toolInput(
				`${uid}-${name}`,
				label,
				`type="number" min="0"${max ? ` max="${max}"` : ""} step="1" value="${value}" data-${name}`,
				max ? `Enter 0 to ${max}.` : undefined,
			);
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Calculator</p>
					<h3>Offer eligibility and funding</h3>
				</div>
				<p>Enter the user’s request, pool balances, and credit config to see which offers the bot can sign and where capital is drawn from.</p>
			</div>
			<div class="tool-input-groups">
				<div class="tool-input-group">
					<strong>Request</strong>
					<div class="tool-grid tool-grid-compact">
						${money("request-amount", "User requested amount", "500", "Enter an amount above 0.", " data-min-exclusive")}
						<label>Risk check<select id="${uid}-risk-check" data-risk-check>
							<option value="LOW">Low risk</option>
							<option value="HIGH">High risk</option>
						</select></label>
						${count("validator-count", "Min validator signatures", "2")}
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Available liquidity</strong>
					<div class="tool-grid tool-grid-compact">
						${money("affiliate-pool", "Affiliate pool free", "120")}
						${money("general-pool", "General pool free", "300")}
						${money("eligible-base", "Muon eligible base", "2000")}
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Credit line config</strong>
					<div class="tool-grid tool-grid-compact">
						${money("current-debt", "Current debt", "300")}
						${money("protocol-max-debt", "Protocol max debt", "1000")}
						${money("affiliate-max-debt", "Affiliate max debt", "700")}
						${count("protocol-max-bps", "Protocol max bps", "5000", "10000")}
						${count("affiliate-max-bps", "Affiliate max bps", "3000", "10000")}
						<label>Credit line status<select id="${uid}-credit-blocked" data-credit-blocked>
							<option value="NO">Active</option>
							<option value="PAUSED">Paused</option>
							<option value="BLACKLISTED">User blacklisted</option>
						</select></label>
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Fees</strong>
					<div class="tool-grid tool-grid-compact">
						${count("fee-bps", "Affiliate fee bps", "80", "10000")}
						${money("operator-fee", "Operator fee", "1")}
					</div>
				</div>
			</div>
			<div class="tool-result"></div>
		`;
		const result = mount.querySelector(".tool-result");
		const cappedLimit = values => {
			const positive = values.filter(value => value > 0);
			return positive.length ? Math.min(...positive) : Infinity;
		};
		const describeLimit = value => (Number.isFinite(value) ? formatAmount(value) : "uncapped by config");
		const allocateFastFunding = (amount, affiliatePool, generalPool, creditCapacity, allowCredit = true) => {
			const affiliateAmount = Math.min(amount, affiliatePool);
			let remaining = Math.max(0, amount - affiliateAmount);
			const creditAmount = allowCredit ? Math.min(remaining, creditCapacity) : 0;
			remaining = Math.max(0, remaining - creditAmount);
			const generalAmount = Math.min(remaining, generalPool);
			remaining = Math.max(0, remaining - generalAmount);
			return { affiliateAmount, creditAmount, generalAmount, unfunded: remaining };
		};
		const optionCard = option => `
			<article class="option-card ${option.available ? "is-available" : "is-unavailable"}">
				<div class="option-card-title">
					<span>${escapeHtml(option.type)}</span>
					<strong>${option.available ? "Available" : "Not available"}</strong>
				</div>
				<p>${escapeHtml(option.reason)}</p>
				<div class="option-spend-grid">
					<span><small>Affiliate pool</small><strong>${formatAmount(option.allocation.affiliateAmount)}</strong></span>
					<span><small>Credit advance</small><strong>${formatAmount(option.allocation.creditAmount)}</strong></span>
					<span><small>General pool</small><strong>${formatAmount(option.allocation.generalAmount)}</strong></span>
					${option.allocation.unfunded > 0 ? `<span><small>Unfunded</small><strong>${formatAmount(option.allocation.unfunded)}</strong></span>` : ""}
				</div>
			</article>
		`;
		const numericFields = [
			["requestAmount", "user requested amount", "[data-request-amount]"],
			["validatorCount", "min validator signatures", "[data-validator-count]"],
			["affiliatePool", "affiliate pool free", "[data-affiliate-pool]"],
			["generalPool", "general pool free", "[data-general-pool]"],
			["eligibleBase", "Muon eligible base", "[data-eligible-base]"],
			["currentDebt", "current debt", "[data-current-debt]"],
			["protocolMaxDebt", "protocol max debt", "[data-protocol-max-debt]"],
			["affiliateMaxDebt", "affiliate max debt", "[data-affiliate-max-debt]"],
			["protocolMaxBps", "protocol max bps", "[data-protocol-max-bps]"],
			["affiliateMaxBps", "affiliate max bps", "[data-affiliate-max-bps]"],
			["feeBps", "affiliate fee bps", "[data-fee-bps]"],
			["operatorFee", "operator fee", "[data-operator-fee]"],
		].map(([key, label, selector]) => ({ key, label, input: mount.querySelector(selector) }));
		const compute = () => {
			const values = {};
			const invalidFields = [];
			numericFields.forEach(field => {
				values[field.key] = readChecked(field.input);
				if (values[field.key] == null) invalidFields.push(field);
			});
			if (invalidFields.length) return { html: invalidValuesMessage(invalidFields), invalid: invalidFields.map(field => field.input) };
			const {
				requestAmount,
				validatorCount,
				affiliatePool,
				generalPool,
				eligibleBase,
				currentDebt,
				protocolMaxDebt,
				affiliateMaxDebt,
				protocolMaxBps,
				affiliateMaxBps,
				feeBps,
				operatorFee,
			} = values;
			const riskCheck = mount.querySelector("[data-risk-check]").value;
			const creditBlocked = mount.querySelector("[data-credit-blocked]").value;

			const protocolBpsLimit = protocolMaxBps > 0 ? (eligibleBase * protocolMaxBps) / 10000 : Infinity;
			const affiliateBpsLimit = affiliateMaxBps > 0 ? (eligibleBase * affiliateMaxBps) / 10000 : Infinity;
			const effectiveDebtLimit = cappedLimit([protocolMaxDebt, affiliateMaxDebt, protocolBpsLimit, affiliateBpsLimit]);
			const creditBlockedReason =
				creditBlocked === "PAUSED"
					? "the credit line is paused"
					: creditBlocked === "BLACKLISTED"
						? "the user is blacklisted for credit"
						: "";
			const rawCreditCapacity = Number.isFinite(effectiveDebtLimit) ? Math.max(0, effectiveDebtLimit - currentDebt) : requestAmount;
			const creditCapacity = creditBlocked === "NO" ? rawCreditCapacity : 0;
			const fastAllocation = allocateFastFunding(requestAmount, affiliatePool, generalPool, creditCapacity);
			const standardAllocation = { affiliateAmount: 0, creditAmount: 0, generalAmount: 0, unfunded: 0 };

			const feeAmount = (requestAmount * feeBps) / 10000;
			const userFee = feeAmount + operatorFee;
			const netUserAmount = Math.max(0, requestAmount - userFee);
			const poolDraw = fastAllocation.affiliateAmount + fastAllocation.generalAmount;
			const validatorsReady = validatorCount > 0;
			// The request field rejects 0, so every request here is above 0.
			const fastFundingAvailable = fastAllocation.unfunded <= 0;
			const fundingReason =
				fastAllocation.unfunded > 0 ? `${formatAmount(fastAllocation.unfunded)} is still unfunded after pools and credit.` : "";

			const sameTxReasons = [];
			if (!validatorsReady) sameTxReasons.push("Min validator signatures is 0.");
			if (fundingReason) sameTxReasons.push(fundingReason);
			if (creditBlockedReason && fastAllocation.unfunded > 0) sameTxReasons.push(sentence(creditBlockedReason));
			const windowedReasons = [];
			if (riskCheck !== "LOW") windowedReasons.push("Risk check is high, so the bot should not sign a fast offer.");
			if (fundingReason) windowedReasons.push(fundingReason);
			if (creditBlockedReason && fastAllocation.unfunded > 0) windowedReasons.push(sentence(creditBlockedReason));

			const options = [
				{
					type: "SAME_TX",
					available: validatorsReady && fastFundingAvailable,
					reason: sameTxReasons.length
						? sameTxReasons.join(" ")
						: "Same-transaction payout can be signed because validators are configured and the request can be fully funded.",
					allocation: fastAllocation,
				},
				{
					type: "WINDOWED",
					available: riskCheck === "LOW" && fastFundingAvailable,
					reason: windowedReasons.length
						? windowedReasons.join(" ")
						: "The request can be processed after the security window using the computed pool and credit split.",
					allocation: fastAllocation,
				},
				{
					type: "STANDARD",
					available: true,
					reason: "Always available as the cooldown offer; Express does not front pools or credit for STANDARD.",
					allocation: standardAllocation,
				},
			];
			// STANDARD is always available, so there is always a recommendation.
			const recommended = options.find(option => option.available);
			const warnings = [];
			if (creditBlockedReason) warnings.push(`Credit capacity is zero because ${creditBlockedReason}.`);
			if (fastAllocation.unfunded > 0)
				warnings.push("Fast offers cannot cover the full request with the current pools and credit capacity; STANDARD remains the fallback.");
			if (!validatorsReady) warnings.push("SAME_TX needs Min validator signatures above 0.");
			if (riskCheck !== "LOW") warnings.push("WINDOWED should not be signed while the risk check is high.");
			const verdict = recommended.type;
			const html = `
				<p class="tool-verdict"><small>Recommended offer</small><strong>${escapeHtml(verdict)}</strong></p>
				<div class="result-metrics">
					<span><small>Fast offer pool draw</small><strong>${formatAmount(poolDraw)}</strong></span>
					<span><small>Credit capacity</small><strong>${formatAmount(creditCapacity)}</strong></span>
					<span><small>User receives after fees</small><strong>${formatAmount(netUserAmount)}</strong></span>
				</div>
				<div class="option-card-grid">${options.map(optionCard).join("")}</div>
				<p>Effective credit cap is <strong>${describeLimit(effectiveDebtLimit)}</strong>; current debt is <strong>${formatAmount(currentDebt)}</strong>; usable credit for this request is <strong>${formatAmount(creditCapacity)}</strong>.</p>
				<p>Affiliate fee <strong>${formatAmount(feeAmount)}</strong> plus operator fee <strong>${formatAmount(operatorFee)}</strong>: the user pays <strong>${formatAmount(userFee)}</strong> in fees.</p>
				${warnings.length ? `<ul class="tool-warnings">${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
				${!warnings.length ? '<p class="tool-ok">Current config supports a fast offer and a standard fallback.</p>' : ""}
			`;
			const summary = `Recommended offer ${recommended.type}. User receives ${formatAmount(netUserAmount)}.`;
			return { html, summary };
		};
		wireTool(mount, result, compute);
	};

	const installExpressTimingTool = mount => {
		const uid = nextToolId();
		const seconds = (name, label, value, step = "1") =>
			toolInput(`${uid}-${name}`, label, `type="number" min="0" step="${step}" value="${value}" data-${name}`);
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Calculator</p>
					<h3>Processing timeline</h3>
				</div>
				<p>See when the operator, anyone, and STANDARD finalization can process a request.</p>
			</div>
			<div class="tool-grid tool-grid-compact">
				${seconds("security-window", "Security window (seconds)", "20")}
				${seconds("tolerance-period", "Tolerance period (seconds)", "60")}
				${seconds("standard-cooldown", "STANDARD cooldown (hours)", "12", "0.25")}
			</div>
			<div class="timeline-track"></div>
		`;
		const result = mount.querySelector(".timeline-track");
		const fields = [
			["securityWindow", "security window", "[data-security-window]"],
			["tolerancePeriod", "tolerance period", "[data-tolerance-period]"],
			["cooldownHours", "STANDARD cooldown", "[data-standard-cooldown]"],
		].map(([key, label, selector]) => ({ key, label, input: mount.querySelector(selector) }));
		const compute = () => {
			const values = {};
			const invalidFields = fields.filter(field => (values[field.key] = readChecked(field.input)) == null);
			if (invalidFields.length) return { html: invalidValuesMessage(invalidFields), invalid: invalidFields.map(field => field.input) };
			const { securityWindow, tolerancePeriod, cooldownHours } = values;
			const permissionless = securityWindow + tolerancePeriod;
			const html = `
				<div class="timeline-item"><span>Accept</span><strong>T + 0s</strong><small>Request enters ExpressProvider state.</small></div>
				<div class="timeline-item"><span>Operator</span><strong>T + ${formatDuration(securityWindow)}</strong><small>Operator can process WINDOWED if not locked.</small></div>
				<div class="timeline-item"><span>Permissionless</span><strong>T + ${formatDuration(permissionless)}</strong><small>Anyone can process after tolerance expires.</small></div>
				<div class="timeline-item"><span>STANDARD</span><strong>T + ${formatDuration(cooldownHours * 3600)}</strong><small>Symmio cooldown target before finalization.</small></div>
			`;
			return { html, summary: `Permissionless processing at T plus ${formatDuration(permissionless)}.` };
		};
		wireTool(mount, result, compute);
	};
	const ADJUSTMENT_SCALE = 1000000000000000000n;

	const parseScaledFactor = raw => {
		const text = String(raw == null ? "" : raw).trim();
		if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
		const [whole, fraction = ""] = text.split(".");
		if (fraction.length > 18) return null;
		const padded = (fraction + "000000000000000000").slice(0, 18);
		const value = BigInt(whole || "0") * ADJUSTMENT_SCALE + BigInt(padded);
		return value > 0n ? value : null;
	};

	const parseSignedInteger = raw => {
		const text = String(raw == null ? "" : raw)
			.trim()
			.replace(/[_,\s]/g, "");
		if (!/^-?\d+$/.test(text)) return null;
		return BigInt(text);
	};

	const parseUnsignedInteger = raw => {
		const value = parseSignedInteger(raw);
		return value == null || value < 0n ? null : value;
	};

	const formatFactor = value => {
		const whole = value / ADJUSTMENT_SCALE;
		const fraction = (value % ADJUSTMENT_SCALE).toString().padStart(18, "0").replace(/0+$/, "");
		return fraction ? `${whole}.${fraction}` : `${whole}`;
	};

	const formatBigInt = value => {
		const negative = value < 0n;
		const digits = (negative ? -value : value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		return negative ? `-${digits}` : digits;
	};

	const scaleDown = (amount, factor) => (amount * factor) / ADJUSTMENT_SCALE;

	const convertAmountPricePair = (amount, price, factor, adjustedAmount = scaleDown(amount, factor)) => {
		if (adjustedAmount === 0n) return { adjustedAmount, adjustedPrice: 0n, oldNotional: amount * price, newNotional: 0n, dust: 0n };
		const adjustedPrice = price === 0n ? 0n : (amount * price) / adjustedAmount;
		const oldNotional = amount * price;
		const newNotional = adjustedAmount * adjustedPrice;
		return { adjustedAmount, adjustedPrice, oldNotional, newNotional, dust: oldNotional - newNotional };
	};

	const installSymbolAdjustmentTool = mount => {
		const uid = nextToolId();
		const wholeNumber = "Enter a whole number, 0 or more.";
		const field = (name, label, mode, value, error) =>
			toolInput(`${uid}-${name}`, label, `type="text" inputmode="${mode}" value="${value}" data-${name}`, error);
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Calculator</p>
					<h3>Factor and quote conversion</h3>
				</div>
				<p>Describe one venue event and one stored quote. The panel shows the price Muon must publish on the adjusted-price route, and the rewritten fields, rounding dust, and rejection rules on the physical route.</p>
			</div>
			<div class="tool-input-groups">
				<div class="tool-input-group">
					<strong>Venue event</strong>
					<div class="tool-grid tool-grid-compact">
						${field("active-factor", "Active factor", "decimal", "1", "Enter a decimal above 0.")}
						${field("event-factor", "This event’s factor", "decimal", "4", "Enter a decimal above 0.")}
						${field("venue-price", "Raw venue price after event", "numeric", "100", wholeNumber)}
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Quote as stored, in raw amount units</strong>
					<div class="tool-grid tool-grid-compact">
						${field("quantity", "Quantity <code>quantity</code>", "numeric", "100", "Enter a whole number above 0.")}
						${field("opened-price", "Opened price <code>openedPrice</code>", "numeric", "400", wholeNumber)}
						${field("closed-amount", "Closed amount <code>closedAmount</code>", "numeric", "0", wholeNumber)}
						${field("avg-closed-price", "Average closed price <code>avgClosedPrice</code>", "numeric", "0", wholeNumber)}
						${field("quantity-to-close", "Quantity to close <code>quantityToClose</code>", "numeric", "0", wholeNumber)}
						${field("requested-close-price", "Requested close price <code>requestedClosePrice</code>", "numeric", "0", wholeNumber)}
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Funding</strong>
					<div class="tool-grid tool-grid-compact">
						${field("funding-rate", "Current rate per old unit", "numeric", "8", "Enter a whole number.")}
					</div>
				</div>
			</div>
			<div class="tool-result"></div>
		`;
		const result = mount.querySelector(".tool-result");
		const readField = (selector, parser) => parser(mount.querySelector(selector).value);
		const row = (label, before, after, note) =>
			`<tr><td><code>${escapeHtml(label)}</code></td><td>${before}</td><td>${after}</td><td>${note}</td></tr>`;

		const inputFor = selector => mount.querySelector(selector);
		const compute = () => {
			const activeFactor = readField("[data-active-factor]", parseScaledFactor);
			const eventFactor = readField("[data-event-factor]", parseScaledFactor);
			const venuePrice = readField("[data-venue-price]", parseUnsignedInteger);
			const quantity = readField("[data-quantity]", parseUnsignedInteger);
			const openedPrice = readField("[data-opened-price]", parseUnsignedInteger);
			const closedAmount = readField("[data-closed-amount]", parseUnsignedInteger);
			const avgClosedPrice = readField("[data-avg-closed-price]", parseUnsignedInteger);
			const quantityToClose = readField("[data-quantity-to-close]", parseUnsignedInteger);
			const requestedClosePrice = readField("[data-requested-close-price]", parseUnsignedInteger);
			const fundingRate = readField("[data-funding-rate]", parseSignedInteger);

			const missing = [
				[activeFactor, "active factor", "[data-active-factor]"],
				[eventFactor, "this event’s factor", "[data-event-factor]"],
				[venuePrice, "raw venue price", "[data-venue-price]"],
				[quantity, "quantity", "[data-quantity]"],
				[openedPrice, "opened price", "[data-opened-price]"],
				[closedAmount, "closed amount", "[data-closed-amount]"],
				[avgClosedPrice, "average closed price", "[data-avg-closed-price]"],
				[quantityToClose, "quantity to close", "[data-quantity-to-close]"],
				[requestedClosePrice, "requested close price", "[data-requested-close-price]"],
				[fundingRate, "funding rate", "[data-funding-rate]"],
			].filter(([value]) => value == null);
			if (missing.length)
				return {
					html: `<ul class="tool-warnings"><li>Enter a valid value for ${escapeHtml(missing.map(([, label]) => label).join(", "))}. Factors are positive decimals; amounts and prices are whole numbers; the funding rate may be negative.</li></ul>`,
					invalid: missing.map(([, , selector]) => inputFor(selector)),
				};
			if (quantity === 0n)
				return {
					html: `<ul class="tool-warnings"><li>Enter a <code>quantity</code> above 0. A stored quote always has one.</li></ul>`,
					invalid: [inputFor("[data-quantity]")],
				};
			if (closedAmount > quantity)
				return { html: `<ul class="tool-warnings"><li><code>closedAmount</code> cannot exceed <code>quantity</code>.</li></ul>` };

			const prospectiveFactor = (activeFactor * eventFactor) / ADJUSTMENT_SCALE;
			if (prospectiveFactor === 0n)
				return {
					html: `<ul class="tool-warnings"><li>The two factors compound to zero: <code>floor(${escapeHtml(formatFactor(activeFactor))} &times; ${escapeHtml(formatFactor(eventFactor))})</code> floors away entirely. Confirmation, direct start, and preview all reject this product.</li></ul>`,
				};

			// Adjusted-price route: external prices are lifted onto the stored quote basis.
			const adjustedMark = scaleDown(venuePrice, prospectiveFactor);
			const storedOpenAmount = quantity - closedAmount;
			const venueOpenAmount = scaleDown(storedOpenAmount, prospectiveFactor);
			const venueClosedAmount = scaleDown(closedAmount, prospectiveFactor);
			const venueQuantity = venueOpenAmount + venueClosedAmount;
			const legacyVenueQuantity = scaleDown(quantity, prospectiveFactor);
			const legacyVenueOpenAmount = legacyVenueQuantity - venueClosedAmount;
			const upnlRaw = storedOpenAmount * (venuePrice - openedPrice);
			const upnlAdjusted = storedOpenAmount * (adjustedMark - openedPrice);

			// Physical route: a direct restatement converts by the prospective factor.
			const position = convertAmountPricePair(quantity, openedPrice, prospectiveFactor, venueQuantity);
			const closed = convertAmountPricePair(closedAmount, avgClosedPrice, prospectiveFactor);
			const closeRequest = convertAmountPricePair(quantityToClose, requestedClosePrice, prospectiveFactor);

			const rejections = [];
			if (position.adjustedAmount === 0n)
				rejections.push(
					`The whole position vanishes: converted open amount plus converted closed amount is <code>0</code>. Core will not store a zero-quantity position.`,
				);
			if (closedAmount > 0n && closed.adjustedAmount === 0n)
				rejections.push(
					`Recorded closed quantity vanishes: <code>floor(${escapeHtml(formatBigInt(closedAmount))} &times; factor) = 0</code>. Core will not erase closed history.`,
				);
			if (venueOpenAmount === 0n)
				rejections.push(
					`No open quantity survives: <code>floor((${escapeHtml(formatBigInt(quantity))} - ${escapeHtml(formatBigInt(closedAmount))}) &times; factor) = 0</code>. Core will not manufacture open size from total-quantity rounding.`,
				);
			if (quantityToClose > 0n && closeRequest.adjustedAmount === 0n)
				rejections.push(
					`The pending close request vanishes: <code>floor(${escapeHtml(formatBigInt(quantityToClose))} &times; factor) = 0</code>. Core will not keep a close request for zero quantity.`,
				);

			const restatable = rejections.length === 0;
			const totalDust = position.dust + closed.dust + closeRequest.dust;
			const rateMagnitude = fundingRate < 0n ? -fundingRate : fundingRate;
			const restoredMagnitude = (rateMagnitude * ADJUSTMENT_SCALE) / prospectiveFactor;
			const restoredRate = fundingRate < 0n ? -restoredMagnitude : restoredMagnitude;
			const fundingBefore = storedOpenAmount * fundingRate;
			const fundingAfter = venueOpenAmount * restoredRate;

			const notes = [];
			if (legacyVenueOpenAmount !== venueOpenAmount)
				notes.push(
					`The old independent-total method would produce open amount <code>${escapeHtml(formatBigInt(legacyVenueOpenAmount))}</code>. Core instead scales the actual stored open amount to <code>${escapeHtml(formatBigInt(venueOpenAmount))}</code> and reconstructs quantity, preventing that ${escapeHtml(formatBigInt(legacyVenueOpenAmount - venueOpenAmount))}-wei carry from changing position size.`,
				);
			if (restatable && totalDust > 0n)
				notes.push(
					`Integer division discards <code>${escapeHtml(formatBigInt(totalDust))}</code> of notional across the converted pairs. Each pair’s dust is <code>oldNotional % adjustedAmount</code>, always smaller than the converted amount.`,
				);
			if (restatable && fundingBefore !== fundingAfter)
				notes.push(
					`Flooring the restored rate moves the funding amount from <code>${escapeHtml(formatBigInt(fundingBefore))}</code> to <code>${escapeHtml(formatBigInt(fundingAfter))}</code>.`,
				);
			if (activeFactor !== ADJUSTMENT_SCALE)
				notes.push(
					`A direct restatement converts by the prospective factor shown. A restatement opened later, after <code>confirmPriceAdjusted</code>, would instead convert by the active factor <code>${escapeHtml(formatFactor(activeFactor))}</code>.`,
				);

			const html = `
				<div class="result-metrics">
					<span><small>Prospective factor</small><strong>${escapeHtml(formatFactor(prospectiveFactor))}x</strong></span>
					<span><small>Adjusted mark Muon publishes</small><strong>${escapeHtml(formatBigInt(adjustedMark))}</strong></span>
					<span><small>Physical conversion</small><strong>${restatable ? "Accepted" : "Rejected"}</strong></span>
					<span><small>Notional dust</small><strong>${restatable ? escapeHtml(formatBigInt(totalDust)) : "n/a"}</strong></span>
				</div>
				<h4>Adjusted-price route, storage untouched</h4>
				<p>
					Muon multiplies the raw venue price by the factor: <code>floor(${escapeHtml(formatBigInt(venuePrice))} &times; ${escapeHtml(formatFactor(prospectiveFactor))}) = ${escapeHtml(formatBigInt(adjustedMark))}</code>.
					Feeding Core the raw <code>${escapeHtml(formatBigInt(venuePrice))}</code> instead would report a price UPNL of
					<code>${escapeHtml(formatBigInt(upnlRaw))}</code> on this long, against the correct
					<code>${escapeHtml(formatBigInt(upnlAdjusted))}</code>.
					<code>getQuoteInVenueUnits</code> reports quantity <code>${escapeHtml(formatBigInt(venueQuantity))}</code>,
					closed amount <code>${escapeHtml(formatBigInt(venueClosedAmount))}</code>, and open amount
					<code>${escapeHtml(formatBigInt(venueOpenAmount))}</code> for display only.
				</p>
				<h4>Physical route, storage rewritten</h4>
				<div class="table-wrap">
					<table>
						<thead><tr><th>Field</th><th>Stored</th><th>Rewritten</th><th>Notional</th></tr></thead>
						<tbody>
							${row("quantity / openedPrice", `${escapeHtml(formatBigInt(quantity))} @ ${escapeHtml(formatBigInt(openedPrice))}`, `${escapeHtml(formatBigInt(position.adjustedAmount))} @ ${escapeHtml(formatBigInt(position.adjustedPrice))}`, `${escapeHtml(formatBigInt(position.oldNotional))} &rarr; ${escapeHtml(formatBigInt(position.newNotional))}${position.dust > 0n ? ` (dust ${escapeHtml(formatBigInt(position.dust))})` : ""}`)}
							${closedAmount > 0n ? row("closedAmount / avgClosedPrice", `${escapeHtml(formatBigInt(closedAmount))} @ ${escapeHtml(formatBigInt(avgClosedPrice))}`, `${escapeHtml(formatBigInt(closed.adjustedAmount))} @ ${escapeHtml(formatBigInt(closed.adjustedPrice))}`, `${escapeHtml(formatBigInt(closed.oldNotional))} &rarr; ${escapeHtml(formatBigInt(closed.newNotional))}${closed.dust > 0n ? ` (dust ${escapeHtml(formatBigInt(closed.dust))})` : ""}`) : row("closedAmount / avgClosedPrice", "0", "0", "not converted while zero")}
							${quantityToClose > 0n ? row("quantityToClose / requestedClosePrice", `${escapeHtml(formatBigInt(quantityToClose))} @ ${escapeHtml(formatBigInt(requestedClosePrice))}`, `${escapeHtml(formatBigInt(closeRequest.adjustedAmount))} @ ${escapeHtml(formatBigInt(closeRequest.adjustedPrice))}`, `${escapeHtml(formatBigInt(closeRequest.oldNotional))} &rarr; ${escapeHtml(formatBigInt(closeRequest.newNotional))}${closeRequest.dust > 0n ? ` (dust ${escapeHtml(formatBigInt(closeRequest.dust))})` : ""}`) : row("quantityToClose / requestedClosePrice", "0", "0", "not converted while zero")}
							${row("current funding rate", `${escapeHtml(formatBigInt(fundingRate))} per old unit`, `${escapeHtml(formatBigInt(restoredRate))} per new unit`, `${escapeHtml(formatBigInt(fundingBefore))} &rarr; ${escapeHtml(formatBigInt(fundingAfter))}`)}
						</tbody>
					</table>
				</div>
				${rejections.length ? `<ul class="tool-warnings">${rejections.map(entry => `<li>${entry}</li>`).join("")}</ul>` : `<p class="tool-ok">Every amount survives the conversion, so <code>applyAdjustment</code> would rewrite this quote. The dust exception does not apply.</p>`}
				${notes.length ? `<ul class="tool-notes">${notes.map(entry => `<li>${entry}</li>`).join("")}</ul>` : ""}
			`;
			return { html, summary: `Physical conversion ${restatable ? "Accepted" : "Rejected"}.` };
		};
		wireTool(mount, result, compute);
	};

	const installExpressTools = () => {
		document.querySelectorAll("[data-express-funding-tool]").forEach(installExpressFundingTool);
		document.querySelectorAll("[data-express-timing-tool]").forEach(installExpressTimingTool);
		document.querySelectorAll("[data-symbol-adjustment-tool]").forEach(installSymbolAdjustmentTool);
	};

	installExpressTools();

	const solidityKeywords = new Set([
		"abstract",
		"after",
		"anonymous",
		"as",
		"assembly",
		"break",
		"calldata",
		"catch",
		"constant",
		"constructor",
		"continue",
		"contract",
		"delete",
		"do",
		"else",
		"emit",
		"enum",
		"error",
		"event",
		"external",
		"fallback",
		"for",
		"from",
		"function",
		"if",
		"immutable",
		"import",
		"indexed",
		"inherited",
		"interface",
		"internal",
		"is",
		"library",
		"mapping",
		"memory",
		"modifier",
		"new",
		"override",
		"payable",
		"pragma",
		"private",
		"public",
		"pure",
		"receive",
		"returns",
		"revert",
		"storage",
		"struct",
		"try",
		"type",
		"unchecked",
		"using",
		"view",
		"virtual",
		"while",
	]);
	const solidityTypes = new Set([
		"address",
		"bool",
		"byte",
		"bytes",
		"bytes1",
		"bytes2",
		"bytes3",
		"bytes4",
		"bytes8",
		"bytes16",
		"bytes20",
		"bytes32",
		"int",
		"int8",
		"int16",
		"int32",
		"int64",
		"int128",
		"int256",
		"string",
		"uint",
		"uint8",
		"uint16",
		"uint24",
		"uint32",
		"uint64",
		"uint128",
		"uint160",
		"uint256",
	]);
	// Shared tokenizer: comments, strings, numbers, then keywords, types and capitalized symbols.
	const highlightTokens = (source, tokenPattern, keywords, types) => {
		let html = "";
		let index = 0;
		for (const match of source.matchAll(tokenPattern)) {
			const token = match[0];
			html += escapeHtml(source.slice(index, match.index));
			let className = "";
			if (token.startsWith("//") || token.startsWith("/*")) className = "tok-comment";
			else if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) className = "tok-string";
			else if (/^(0x[a-fA-F0-9]+|\d)/.test(token)) className = "tok-number";
			else if (keywords.has(token)) className = "tok-keyword";
			else if (types.has(token)) className = "tok-type";
			else if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) className = "tok-symbol";
			html += className ? `<span class="${className}">${escapeHtml(token)}</span>` : escapeHtml(token);
			index = match.index + token.length;
		}
		html += escapeHtml(source.slice(index));
		return html;
	};

	const solidityTokenPattern =
		/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b0x[a-fA-F0-9]+\b|\b\d+(?:_\d+)*(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
	const highlightSolidity = source => highlightTokens(source, solidityTokenPattern, solidityKeywords, solidityTypes);

	// TypeScript and JavaScript add template strings, bigint literals (1n) and $ in identifiers.
	const scriptTokenPattern =
		/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[a-fA-F0-9]+n?\b|\b\d+(?:_\d+)*(?:\.\d+)?n?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;
	const scriptKeywords = new Set([
		"as",
		"async",
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"default",
		"delete",
		"do",
		"else",
		"export",
		"extends",
		"false",
		"finally",
		"for",
		"from",
		"function",
		"if",
		"import",
		"in",
		"instanceof",
		"interface",
		"let",
		"new",
		"null",
		"of",
		"return",
		"switch",
		"this",
		"throw",
		"true",
		"try",
		"type",
		"typeof",
		"undefined",
		"var",
		"void",
		"while",
		"yield",
	]);
	const scriptTypes = new Set(["any", "bigint", "boolean", "never", "number", "object", "string", "unknown"]);
	const scriptLanguages = ["language-typescript", "language-javascript", "language-ts", "language-js"];
	const highlightScript = source => highlightTokens(source, scriptTokenPattern, scriptKeywords, scriptTypes);

	const looksLikeSolidity = source => {
		const trimmed = source.trim();
		if (!trimmed) return false;
		const firstLine = trimmed.split("\n").find(Boolean) || "";
		if (
			/^(Scenario|Example|Bot sees|On withdrawal request|if user(?:-requested|\s+requested)|reserveDebt|activateDebt|settleDebt)\b/i.test(
				firstLine,
			)
		)
			return false;
		if (/[─→►]/.test(trimmed)) return false;

		const strongSignals = [
			/\b(function|struct|enum|event|error|modifier|mapping|contract|interface|library|pragma|import)\b/,
			/\b(external|public|internal|private|payable|view|pure|returns|calldata|memory|storage|immutable|override)\b/,
			/\b(uint(?:8|16|24|32|64|128|160|256)?|int(?:8|16|32|64|128|256)?|address|bytes(?:2|3|4|8|16|20|32)?|bool|string)\b/,
			/\b(abi\.encode|abi\.decode|keccak256|msg\.sender|msg\.value|onlyRole|require|revert|emit)\b/,
			/\b[A-Z][A-Za-z0-9_]*\s*\([^)]*(?:address|uint|bytes|bool|string)\b/,
		];
		if (strongSignals.some(pattern => pattern.test(trimmed))) return true;

		const codeLines = trimmed
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		if (!codeLines.length || codeLines.length > 12) return false;
		const assignmentLike = codeLines.filter(line => /^[A-Za-z_][\w.]*\s*=\s*[\w.()+\-*/\s]+$/.test(line)).length;
		return assignmentLike >= Math.max(1, Math.ceil(codeLines.length * 0.6));
	};

	document.querySelectorAll(".doc-article pre > code").forEach(code => {
		if (code.classList.contains("language-mermaid")) return;
		const hasLanguage = Array.from(code.classList).some(item => item.startsWith("language-"));
		const source = code.textContent || "";
		if (code.classList.contains("language-solidity") || (!hasLanguage && looksLikeSolidity(source))) {
			code.classList.add("language-solidity");
			code.dataset.detectedLanguage = "solidity";
			code.innerHTML = highlightSolidity(source);
		} else if (scriptLanguages.some(language => code.classList.contains(language))) {
			code.innerHTML = highlightScript(source);
		}
	});

	// Inline identifiers read like miniature code blocks: call name, args, punctuation.
	// A single pass so member access (a.b), indexing (a[b]) and operators get the
	// same treatment as calls -- not just the fn(args) shape.
	const escapeCode = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const codeToken = /([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)|([(),.[\]=<>;:]+)|([\s\S])/g;

	const tokenizeInlineCode = text => {
		let depth = 0;
		let html = "";
		let match;
		codeToken.lastIndex = 0;
		while ((match = codeToken.exec(text))) {
			const [raw, identifier, number, punctuation] = match;
			if (identifier) {
				// Only a following "(" proves this is a call; inside brackets it is an argument.
				const cls = text[codeToken.lastIndex] === "(" ? "tok-fn" : depth > 0 ? "tok-arg" : "";
				html += cls ? '<span class="' + cls + '">' + escapeCode(raw) + "</span>" : escapeCode(raw);
			} else if (number) {
				html += '<span class="tok-num">' + escapeCode(raw) + "</span>";
			} else if (punctuation) {
				for (const char of raw) {
					if (char === "(" || char === "[") depth += 1;
					else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
				}
				html += '<span class="tok-punct">' + escapeCode(raw) + "</span>";
			} else {
				html += escapeCode(raw);
			}
		}
		return html;
	};

	document.querySelectorAll(".doc-article :not(pre) > code, .reader-hero :not(pre) > code").forEach(node => {
		if (node.querySelector("span")) return;
		const text = node.textContent || "";
		if (!/[(),.[\]=<>]/.test(text)) return;
		node.innerHTML = tokenizeInlineCode(text);
	});

	const isApplePlatform = /Mac|iPhone|iPad/.test(navigator.platform || "");
	document.querySelectorAll(".doc-article pre").forEach(pre => {
		if (pre.closest(".mermaid-frame")) return;
		if (pre.closest(".code-frame")) return;
		const code = pre.querySelector("code");
		const frame = document.createElement("div");
		frame.className = "code-frame";
		if (code && code.classList.contains("language-solidity")) frame.classList.add("code-frame-solidity");
		const toolbar = document.createElement("div");
		toolbar.className = "code-toolbar";
		const langMatch = code && /language-([a-z0-9+#-]+)/i.exec(code.className || "");
		const langLabel = document.createElement("span");
		langLabel.className = "code-lang";
		langLabel.textContent = langMatch ? langMatch[1] : "text";
		toolbar.append(langLabel);
		const actions = document.createElement("div");
		actions.className = "code-actions";
		const wrap = document.createElement("button");
		wrap.type = "button";
		setIconLabel(wrap, icons.wrap, "Wrap");
		wrap.addEventListener("click", () => {
			frame.classList.toggle("is-wrapped");
			setIconLabel(wrap, icons.wrap, frame.classList.contains("is-wrapped") ? "Unwrap" : "Wrap");
			syncScrollRegions();
		});
		// Both icons stay in the button so CSS can cross-fade them on .is-copied.
		const copy = document.createElement("button");
		copy.type = "button";
		copy.innerHTML = `<span class="copy-icons"><span class="icon-default">${icons.copy}</span><span class="icon-done">${icons.check}</span></span><span class="copy-label">Copy</span>`;
		const copyLabel = copy.querySelector(".copy-label");
		let copyTimer = 0;
		const showCopyState = (label, copied, duration) => {
			window.clearTimeout(copyTimer);
			copy.classList.toggle("is-copied", copied);
			copyLabel.textContent = label;
			copyTimer = window.setTimeout(() => {
				copy.classList.remove("is-copied");
				copyLabel.textContent = "Copy";
			}, duration);
		};
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(pre.textContent || "");
				showCopyState("Copied", true, 2000);
				announce("Code copied");
			} catch (_error) {
				const selection = window.getSelection();
				if (selection) {
					const range = document.createRange();
					range.selectNodeContents(pre);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				const selected = Boolean(selection && selection.toString().length);
				const label = selected ? (isApplePlatform ? "Press ⌘C to copy" : "Press Ctrl+C to copy") : "Select the code to copy";
				showCopyState(label, false, 4000);
				announce(label);
			}
		});
		actions.append(wrap, copy);
		toolbar.append(actions);
		pre.before(frame);
		frame.append(toolbar, pre);
	});

	/* Every wide table needs its own scroll container or it pushes the article
	   sideways on narrow screens. v0.8.6 pages author the wrapper; older pages do
	   not, so add it wherever it is missing. */
	const installTableScrollers = () => {
		document.querySelectorAll(".doc-article table").forEach(table => {
			if (table.parentElement?.classList.contains("table-wrap")) return;
			const wrapper = document.createElement("div");
			wrapper.className = "table-wrap";
			table.before(wrapper);
			wrapper.append(table);
		});
	};

	installTableScrollers();

	/* A region that scrolls sideways must be reachable by keyboard (Safari does not
	   focus scrollers on its own). Only overflowing ones become tab stops, and only
	   the attributes added here are ever removed. */
	const CODE_LANGUAGE_NAMES = {
		solidity: "Solidity",
		typescript: "TypeScript",
		ts: "TypeScript",
		javascript: "JavaScript",
		js: "JavaScript",
		json: "JSON",
		bash: "Bash",
		sh: "Shell",
		shell: "Shell",
		text: "",
	};
	const scrollRegionLabel = element => {
		if (element.classList.contains("table-wrap")) return "Scrollable table";
		if (element.classList.contains("mermaid")) {
			const caption = (element.closest(".mermaid-frame")?.querySelector("figcaption > span")?.textContent || "").trim();
			// Captions usually end in their type ("…: flow diagram"); do not say "diagram" twice.
			return /\bdiagram$/i.test(caption) ? `${caption}, scrollable` : `${caption || "Untitled"} diagram, scrollable`;
		}
		const language = (element.closest(".code-frame")?.querySelector(".code-lang")?.textContent || "").trim().toLowerCase();
		const name = language in CODE_LANGUAGE_NAMES ? CODE_LANGUAGE_NAMES[language] : language.charAt(0).toUpperCase() + language.slice(1);
		return name ? `${name} code` : "Code";
	};
	function syncScrollRegions() {
		// Drawn diagrams scroll sideways on phones (they keep at least 720px or their natural width).
		document.querySelectorAll(".table-wrap, .code-frame pre, .mermaid-frame > .mermaid").forEach(element => {
			const overflowing = element.scrollWidth > element.clientWidth + 1;
			const managed = element.hasAttribute("data-scroll-region");
			if (overflowing && !managed) {
				if (element.hasAttribute("tabindex")) return;
				element.tabIndex = 0;
				element.setAttribute("role", "region");
				element.setAttribute("aria-label", scrollRegionLabel(element));
				element.setAttribute("data-scroll-region", "");
				// The diagram frame clips overflow, so the shared focus ring is drawn inside the canvas.
				if (element.classList.contains("mermaid")) element.style.outlineOffset = "-2px";
			} else if (!overflowing && managed) {
				["tabindex", "role", "aria-label", "data-scroll-region"].forEach(attribute => element.removeAttribute(attribute));
				element.style.removeProperty("outline-offset");
			}
		});
	}
	syncScrollRegions();
	let scrollRegionTimer = 0;
	window.addEventListener("resize", () => {
		window.clearTimeout(scrollRegionTimer);
		scrollRegionTimer = window.setTimeout(syncScrollRegions, 150);
	});

	const installHeadingLinks = () => {
		document.querySelectorAll(".doc-article h2[id], .doc-article h3[id]").forEach(heading => {
			if (heading.querySelector(".heading-anchor")) return;
			const title = (heading.textContent || "section").trim();
			// The button is a child of the heading, so its label would otherwise fold
			// into the heading's accessible name and be announced twice. Naming the
			// heading from its own text keeps the two separate.
			const text = document.createElement("span");
			text.className = "heading-text";
			text.id = `${heading.id}-text`;
			while (heading.firstChild) text.append(heading.firstChild);
			heading.append(text);
			heading.setAttribute("aria-labelledby", text.id);

			// A real link, so open-in-new-tab and copy-link-address work; a plain
			// click also puts the section in the address bar and copies it.
			const anchor = document.createElement("a");
			anchor.className = "heading-anchor";
			anchor.href = `#${heading.id}`;
			anchor.textContent = "#";
			anchor.setAttribute("aria-label", `Copy link to ${title}`);
			let anchorTimer = 0;
			anchor.addEventListener("click", async event => {
				if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				event.preventDefault();
				window.history.replaceState(null, "", `#${heading.id}`);
				window.clearTimeout(anchorTimer);
				try {
					await navigator.clipboard.writeText(window.location.href);
					anchor.textContent = "✓";
					announce("Section link copied");
				} catch (_error) {
					anchor.textContent = "#";
					announce("Link is in the address bar");
				}
				anchorTimer = window.setTimeout(() => {
					anchor.textContent = "#";
				}, 2000);
			});
			heading.append(anchor);
		});
	};

	installHeadingLinks();
})();
