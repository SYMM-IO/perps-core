// Apply authored semantic decisions. Source remains complete if this layer fails.
(() => {
	"use strict";
	const body = document.body;
	if (!body || body.dataset.annotationsState === "loading" || body.dataset.annotationsReady) return;
	body.dataset.annotationsState = "loading";
	const assetUrl = document.currentScript?.src;
	const normalize = text => text.replace(/\s+/g, " ").trim();
	const ignored = "pre, script, style, button, svg, .code-actions, .annotation-note, .visually-hidden";

	function textMap(element) {
		const nodes = [];
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				return node.parentElement.closest(ignored) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
			},
		});
		let raw = "";
		while (walker.nextNode()) {
			const node = walker.currentNode;
			nodes.push({ node, start: raw.length, end: raw.length + node.length });
			raw += node.data;
		}
		let text = "";
		const positions = [];
		for (let i = 0; i < raw.length; ) {
			if (/\s/.test(raw[i])) {
				let end = i + 1;
				while (end < raw.length && /\s/.test(raw[end])) end++;
				if (text && end < raw.length) {
					text += " ";
					positions.push({ start: i, end });
				}
				i = end;
			} else {
				text += raw[i];
				positions.push({ start: i, end: i + 1 });
				i++;
			}
		}
		return { text, positions, nodes };
	}

	function inSection(element, sectionId, article) {
		if (!sectionId || sectionId === article.id) return true;
		const heading = document.getElementById(sectionId);
		if (!heading || !article.contains(heading)) return false;
		if (heading.contains(element)) return true;
		if (!(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
		const level = Number(heading.tagName.slice(1));
		if (!level) return false;
		const end = [...article.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
			next => Number(next.tagName.slice(1)) <= level && heading.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
		);
		return !end || Boolean(element.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING);
	}

	function decorate(element, record) {
		const map = textMap(element);
		const target = normalize(record.targetQuote);
		const first = map.text.indexOf(target);
		if (!target || first < 0 || map.text.indexOf(target, first + 1) >= 0) return false;
		const start = map.positions[first].start;
		const end = map.positions[first + target.length - 1].end;
		const pieces = map.nodes.filter(part => part.start < end && part.end > start);
		if (record.form === "circle" && pieces.length !== 1) return false;
		for (const part of pieces.reverse()) {
			const range = document.createRange();
			range.setStart(part.node, Math.max(0, start - part.start));
			range.setEnd(part.node, Math.min(part.node.length, end - part.start));
			const mark = document.createElement("span");
			mark.className = `doc-annotation-${record.form}`;
			mark.dataset.annotationId = record.id;
			range.surroundContents(mark);
			if (record.form === "circle") {
				const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				svg.setAttribute("viewBox", "0 0 112 58");
				svg.setAttribute("preserveAspectRatio", "none");
				svg.setAttribute("aria-hidden", "true");
				svg.setAttribute("focusable", "false");
				const path = document.createElementNS(svg.namespaceURI, "path");
				path.setAttribute("d", "M106 27C108 7 77 2 52 5C24 5 3 13 5 31C7 49 38 55 68 51C92 49 108 41 106 25C104 10 73 4 44 7");
				svg.append(path);
				mark.append(svg);
				const fit = () => svg.toggleAttribute("hidden", mark.getClientRects().length !== 1);
				if (window.ResizeObserver) new ResizeObserver(fit).observe(mark.parentElement);
				fit();
			}
		}
		return true;
	}

	function noteText(note, record) {
		let rest = record.note;
		for (const link of record.links || []) {
			const index = rest.indexOf(link.label);
			if (index < 0) throw new Error("note-link-label");
			note.append(document.createTextNode(rest.slice(0, index)));
			const anchor = document.createElement("a");
			anchor.href = link.href;
			anchor.textContent = link.label;
			note.append(anchor);
			rest = rest.slice(index + link.label.length);
		}
		note.append(document.createTextNode(rest));
	}

	function run() {
		const path = decodeURI(location.pathname);
		const chapter = path.match(/\/(v0\.8\.[56])\/pages\/([^/]+)\.html$/);
		const versionIndex = path.match(/\/(v0\.8\.[56])\/index\.html$/);
		const key = chapter
			? `${chapter[1]}/${chapter[2]}`
			: versionIndex
				? `${versionIndex[1]}/index`
				: path.endsWith("deployment-guide.html")
					? "deployment-guide"
					: "index";
		const records = window.__DOC_ANNOTATION_RECORDS__?.[key] || [];
		const article = document.querySelector(".doc-article");
		const errors = [];
		let applied = 0;
		if (article && records.length) {
			const sources = [...article.querySelectorAll("p,li")]
				.filter(element => !element.closest("pre,nav,.annotation-note,.tool-panel"))
				.map(element => ({ element, text: textMap(element).text }));
			for (const record of records) {
				try {
					let matches = sources.filter(
						item => item.text === normalize(record.sourceQuote) && inSection(item.element, record.sectionId, article),
					);
					// A p nested in a li can describe the same words. Bind to its actual text block.
					matches = matches.filter(item => !matches.some(other => other !== item && item.element.contains(other.element)));
					if (matches.length !== 1) throw new Error(`source-matches:${matches.length}`);
					const target = matches[0].element;
					if (record.form === "note") {
						const note = document.createElement("p");
						note.className = "annotation-note doc-annotation-note";
						note.dataset.annotationId = record.id;
						note.dataset.annotationPlacement = record.placement;
						noteText(note, record);
						const before = record.beforeSelector ? article.querySelector(record.beforeSelector) : null;
						if (record.beforeSelector && !before) throw new Error("missing-note-destination");
						if (before) before.before(note);
						else if (target.matches("li")) record.placement === "before" ? target.prepend(note) : target.append(note);
						else record.placement === "before" ? target.before(note) : target.after(note);
					} else if (!decorate(target, record)) throw new Error("target-not-unique-or-renderable");
					applied++;
				} catch (error) {
					errors.push({ id: record.id, reason: error.message });
				}
			}
		}
		body.dataset.annotationsCount = String(applied);
		body.dataset.annotationsExpected = String(records.length);
		body.dataset.annotationsErrors = JSON.stringify(errors);
		body.dataset.annotationsState = errors.length ? "partial" : "ready";
		body.dataset.annotationsReady = "true";
		document.dispatchEvent(new CustomEvent("docs-annotations-ready", { detail: { applied, expected: records.length, errors } }));
	}

	if (window.__DOC_ANNOTATION_RECORDS__) run();
	else if (assetUrl) {
		const data = document.createElement("script");
		data.src = new URL("docs-annotation-data.js", assetUrl).href;
		data.onload = run;
		data.onerror = () => {
			body.dataset.annotationsState = "unavailable";
			body.dataset.annotationsReady = "true";
		};
		document.head.append(data);
	}
})();
