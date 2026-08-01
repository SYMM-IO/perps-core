(() => {
	const root = document.documentElement
	const themeStorage = {
		get() {
			try {
				return window.localStorage ? localStorage.getItem("v086-docs-theme") : null
			} catch (_error) {
				return null
			}
		},
		set(value) {
			try {
				if (window.localStorage) localStorage.setItem("v086-docs-theme", value)
			} catch (_error) {
				// File URLs and embedded browsers can deny storage; the visible toggle still works for this page load.
			}
		},
	}
	const themeButtons = Array.from(document.querySelectorAll("[data-theme-toggle]"))
	const icons = {
		arrowLeft: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
		bookOpen: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>',
		check: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>',
		copy: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
		eyeOff: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M16.7 16.7A10.8 10.8 0 0 1 12 18C7 18 3.7 14.9 2 12c.8-1.4 2.1-2.8 3.6-3.9"/><path d="M9.9 5.2A10.6 10.6 0 0 1 12 5c5 0 8.3 3.1 10 7a12.7 12.7 0 0 1-2.1 3.1"/></svg>',
		expand: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="M9 21H3v-6"/><path d="m3 21 7-7"/></svg>',
		fileDown: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m9 15 3 3 3-3"/></svg>',
		home: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>',
		list: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
		moon: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 7 7 0 1 0 20.5 14.5"/></svg>',
		sun: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/></svg>',
		wrap: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h14a4 4 0 0 1 0 8H7"/><path d="m10 12-3 3 3 3"/></svg>',
	}
	const setIconLabel = (element, icon, label) => {
		element.innerHTML = `${icon}<span>${label}</span>`
	}
	const installButtonIcons = () => {
		document.querySelectorAll(".doc-page .top-actions").forEach((actions) => {
			if (!actions.querySelector('a[href="../index.html"]')) {
				const home = document.createElement("a")
				home.className = "button ghost"
				home.href = "../index.html"
				home.setAttribute("aria-label", "Go home")
				setIconLabel(home, icons.home, "Home")
				actions.prepend(home)
			}
		})
		document.querySelectorAll(".top-actions a.button, .hero-actions a.button, .back-home").forEach((button) => {
			const label = (button.textContent || "").replace(/\s+/g, " ").trim()
			if (!label || button.dataset.iconified) return
			if (label === "Home") setIconLabel(button, icons.home, label)
			else if (label === "Back to index") setIconLabel(button, icons.arrowLeft, label)
			else if (/^View/i.test(label)) setIconLabel(button, icons.bookOpen, label)
			button.dataset.iconified = "true"
		})
	}
	const installPdfExport = () => {
		document.querySelectorAll(".doc-topbar .top-actions").forEach((actions) => {
			if (actions.querySelector("[data-pdf-export]")) return
			const button = document.createElement("button")
			button.type = "button"
			button.className = "button ghost pdf-export"
			button.dataset.pdfExport = "true"
			button.setAttribute("aria-label", "Export this page to PDF")
			button.setAttribute("title", "Export this page to PDF")
			setIconLabel(button, icons.fileDown, "PDF")
			button.addEventListener("click", () => window.print())

			const themeButton = actions.querySelector("[data-theme-toggle]")
			if (themeButton) actions.insertBefore(button, themeButton)
			else actions.append(button)
		})
	}
	const syncThemeButtons = () => {
		const isDark = root.dataset.theme === "dark"
		themeButtons.forEach((button) => {
			setIconLabel(button, isDark ? icons.sun : icons.moon, isDark ? "Light" : "Dark")
			button.setAttribute("aria-pressed", String(isDark))
		})
	}
	const savedTheme = themeStorage.get()
	if (savedTheme === "dark" || savedTheme === "light") {
		root.dataset.theme = savedTheme
	} else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
		root.dataset.theme = "dark"
	}
	syncThemeButtons()
	installButtonIcons()
	installPdfExport()

	themeButtons.forEach((button) => {
		button.addEventListener("click", () => {
			const next = root.dataset.theme === "dark" ? "light" : "dark"
			root.dataset.theme = next
			themeStorage.set(next)
			syncThemeButtons()
			window.dispatchEvent(new CustomEvent("v086-docs:themechange", { detail: { theme: next } }))
		})
	})

	const railStorage = {
		get(key) {
			try {
				return window.localStorage ? localStorage.getItem(key) : null
			} catch (_error) {
				return null
			}
		},
		set(key, value) {
			try {
				if (window.localStorage) localStorage.setItem(key, value)
			} catch (_error) {
				// Storage can be unavailable for local previews; the rail controls still work for this page load.
			}
		},
	}

	const installRailControls = () => {
		const body = document.body
		if (!body || !body.classList.contains("doc-page")) return

		const sectionPanel = document.querySelector(".toc-panel.side-toc")
		const sectionCard = document.querySelector(".side-toc .toc-card")
		if (!sectionPanel || !sectionCard || sectionCard.querySelector("[data-sections-toggle]")) return
		if (!sectionPanel.id) sectionPanel.id = "docs-sections-rail"

		const title = sectionCard.querySelector(".toc-title")
		if (title) title.textContent = "Sections"

		const button = document.createElement("button")
		button.type = "button"
		button.className = "section-toggle"
		button.dataset.sectionsToggle = "true"
		button.setAttribute("aria-controls", sectionPanel.id)

		const sync = (collapsed, persist = true) => {
			body.classList.toggle("rail-right-collapsed", collapsed)
			setIconLabel(button, collapsed ? icons.list : icons.eyeOff, collapsed ? "Sections" : "Hide")
			button.setAttribute("aria-expanded", String(!collapsed))
			button.setAttribute("aria-label", collapsed ? "Show sections sidebar" : "Hide sections sidebar")
			if (persist) railStorage.set("v086-docs-sections-collapsed", String(collapsed))
		}

		sync(railStorage.get("v086-docs-sections-collapsed") === "true", false)
		button.addEventListener("click", () => sync(!body.classList.contains("rail-right-collapsed")))
		sectionCard.prepend(button)
	}

	installRailControls()

	const installArcReaderChrome = () => {
		const body = document.body
		if (!body || !body.classList.contains("doc-page")) return

		const topbar = document.querySelector(".doc-topbar")
		const sectionCard = document.querySelector(".side-toc .toc-card")
		const pageHeading = document.querySelector(".reader-hero h1")
		if (!topbar || !sectionCard || !pageHeading || sectionCard.querySelector(".arc-rail-header")) return

		const brand = topbar.querySelector(".brand")
		const actions = topbar.querySelector(".top-actions")
		const sectionToggle = sectionCard.querySelector("[data-sections-toggle]")
		const category = document.querySelector(".reader-hero .crumbs strong")

		if (!pageHeading.id) pageHeading.id = "document-title"

		const railHeader = document.createElement("div")
		railHeader.className = "arc-rail-header"

		const railTop = document.createElement("div")
		railTop.className = "arc-rail-top"

		if (brand) {
			brand.classList.add("arc-rail-brand")
			railTop.append(brand)
		}

		const railActions = document.createElement("div")
		railActions.className = "arc-rail-actions"
		if (actions) railActions.append(actions)
		if (sectionToggle) railActions.append(sectionToggle)
		railTop.append(railActions)

		const pageLink = document.createElement("a")
		const pageTitle = (pageHeading.textContent || document.title).trim()
		const compactPageTitle = pageTitle.replace(/\s*[-–—]\s*Design Document\s*$/i, "").trim()
		pageLink.className = "arc-rail-page"
		pageLink.href = `#${pageHeading.id}`
		pageLink.setAttribute("aria-label", `Current page: ${pageTitle}`)
		pageLink.innerHTML = `<span>${escapeHtml(category ? category.textContent || "Document" : "Document")}</span><strong>${escapeHtml(
			compactPageTitle || pageTitle
		)}</strong>`

		railHeader.append(railTop, pageLink)
		sectionCard.prepend(railHeader)

		const sectionList = document.createElement("div")
		sectionList.className = "arc-section-list"
		Array.from(sectionCard.children).forEach((child) => {
			if (child.matches(".toc-title, .toc-link, .toc-empty")) sectionList.append(child)
		})
		sectionCard.append(sectionList)
	}

	const normalize = (value) => value.toLowerCase().replace(/\s+/g, " ").trim()
	const escapeHtml = (value) =>
		value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;")

	installArcReaderChrome()

	const installFilter = (input, items, emptyLabel) => {
		if (!input || !items.length) return
		const empty = document.createElement("div")
		empty.className = "no-results is-hidden"
		empty.textContent = emptyLabel
		const parent = items[0].parentElement
		if (parent) parent.append(empty)
		input.addEventListener("input", () => {
			const query = normalize(input.value)
			let shown = 0
			items.forEach((item) => {
				const match = !query || normalize(item.textContent || "").includes(query)
				item.classList.toggle("is-hidden", !match)
				if (match) shown += 1
			})
			empty.classList.toggle("is-hidden", shown !== 0)
		})
	}

	installFilter(
		document.querySelector("[data-filter-docs]"),
		Array.from(document.querySelectorAll(".doc-grid [data-filter-item]")),
		"No matching documentation pages."
	)

	document.querySelectorAll("[data-filter-nav]").forEach((input) => {
		const sidebar = input.closest(".doc-sidebar")
		installFilter(input, Array.from(sidebar ? sidebar.querySelectorAll(".side-link") : []), "No matching docs.")
	})

	const flowHeadingPattern = /\bwithdrawal flows?\b/i
	const cleanSectionLabel = (text) =>
		text
			.replace(/\s+/g, " ")
			.replace(/^\d+(?:\.\d+)*\.?\s*/, "")
			.replace(/\s*\([^)]*\)\s*$/, (match) => match.length > 18 ? "" : match)
			.trim()

	const installProtocolFlowJumps = () => {
		const sections = Array.from(document.querySelectorAll(".doc-article h2[id]")).filter((heading) => flowHeadingPattern.test(heading.id) || flowHeadingPattern.test(heading.textContent || ""))
		sections.forEach((heading) => {
			if (heading.nextElementSibling && heading.nextElementSibling.classList.contains("flow-jump-nav")) return

			const h3s = []
			let cursor = heading.nextElementSibling
			while (cursor && cursor.tagName !== "H2") {
				if (cursor.tagName === "H3" && cursor.id) h3s.push(cursor)
				cursor = cursor.nextElementSibling
			}
			if (h3s.length < 2) return

			const nav = document.createElement("nav")
			nav.className = "flow-jump-nav"
			nav.setAttribute("aria-label", "Withdrawal flow quick links")
			const label = document.createElement("span")
			label.textContent = "Flow sections"
			nav.append(label)
			h3s.forEach((sectionHeading) => {
				const link = document.createElement("a")
				link.href = `#${sectionHeading.id}`
				link.textContent = cleanSectionLabel(sectionHeading.textContent || sectionHeading.id)
				nav.append(link)
			})
			heading.after(nav)
		})
	}

	installProtocolFlowJumps()

	const detectDiagramType = (source) => {
		const first = source.trim().split(/\n/)[0] || ""
		if (/^sequenceDiagram/i.test(first)) return "sequence"
		if (/^(flowchart|graph)\b/i.test(first)) return "flow"
		if (/^stateDiagram/i.test(first)) return "state"
		if (/^gantt/i.test(first)) return "gantt"
		return "diagram"
	}

	const cleanNodeLabel = (value) => {
		const trimmed = value
			.replace(/["'`]/g, "")
			.replace(/<br\s*\/?>/gi, " / ")
			.replace(/\s+/g, " ")
			.trim()
		const bracket = trimmed.match(/^[\w.-]*[\[\(\{]([^()[\]{}]+)[\]\)\}]/)
		return (bracket ? bracket[1] : trimmed.replace(/^[\w.-]+$/, (match) => match)).replace(/&amp;/g, "&")
	}

	const parseSequence = (source) =>
		source
			.split("\n")
			.map((line) => line.trim())
			.map((line) => line.match(/^(.+?)(?:--)?->>[\+ -]*(.+?):\s*(.+)$/))
			.filter(Boolean)
			.slice(0, 18)
			.map((match) => ({
				from: cleanNodeLabel(match[1]),
				to: cleanNodeLabel(match[2]),
				label: cleanNodeLabel(match[3]),
			}))

	const parseFlow = (source) =>
	{
		const nodeLabels = new Map()
		const lines = source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !/^(flowchart|graph|subgraph|end\b|%%)/i.test(line))
		lines.forEach((line) => {
			for (const match of line.matchAll(/\b([A-Za-z][\w.-]*)[\[\(\{]([^()[\]{}]+)[\]\)\}]/g)) {
				nodeLabels.set(match[1], cleanNodeLabel(match[2]))
			}
		})
		const labelFor = (value) => {
			const id = value.trim().match(/^([A-Za-z][\w.-]*)\b/)?.[1]
			return id && nodeLabels.has(id) ? nodeLabels.get(id) : cleanNodeLabel(value)
		}
		return lines
			.map((line) => {
				const label = (line.match(/-->\|([^|]+)\|/) || line.match(/--\s*([^->]+?)\s*-->/) || [])[1] || ""
				const parts = line.replace(/-->\|[^|]+\|/, "-->").split(/-->|---|==>/)
				if (parts.length < 2) return null
				return {
					from: labelFor(parts[0]),
					to: labelFor(parts[1]),
					label: cleanNodeLabel(label),
				}
			})
			.filter(Boolean)
			.slice(0, 18)
	}

	const parseState = (source) =>
		source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.includes("-->"))
			.map((line) => {
				const [from, rest] = line.split("-->")
				const [to, label = ""] = rest.split(":")
				return { from: cleanNodeLabel(from), to: cleanNodeLabel(to), label: cleanNodeLabel(label) }
			})
			.slice(0, 18)

	const parseGantt = (source) =>
		source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.includes(":") && !/^(title|dateFormat|axisFormat|section)\b/i.test(line))
			.slice(0, 16)
			.map((line) => {
				const [label, timing = ""] = line.split(":")
				return { label: cleanNodeLabel(label), timing: cleanNodeLabel(timing) }
			})

	const fillFallbackDiagram = (target, source) => {
		const type = detectDiagramType(source)
		target.className = `diagram-fallback diagram-fallback-${type}`
		target.replaceChildren()

		if (type === "sequence") {
			const steps = parseSequence(source)
			steps.forEach((step, index) => {
				const row = document.createElement("div")
				row.className = "diagram-step"
				row.innerHTML = `<span class="diagram-count">${String(index + 1).padStart(2, "0")}</span><span class="diagram-node">${step.from}</span><span class="diagram-arrow">to</span><span class="diagram-node">${step.to}</span><span class="diagram-message">${step.label}</span>`
				target.append(row)
			})
			return
		}

		if (type === "gantt") {
			parseGantt(source).forEach((task, index) => {
				const row = document.createElement("div")
				row.className = "diagram-task"
				row.innerHTML = `<span style="--bar:${(index % 5) + 4}"></span><strong>${task.label}</strong><small>${task.timing}</small>`
				target.append(row)
			})
			return
		}

		const edges = type === "state" ? parseState(source) : parseFlow(source)
		edges.forEach((edge) => {
			const row = document.createElement("div")
			row.className = "diagram-edge"
			row.innerHTML = `<span class="diagram-node">${edge.from}</span><span class="diagram-arrow">${edge.label || "to"}</span><span class="diagram-node">${edge.to}</span>`
			target.append(row)
		})
	}

	let activeDiagramModal = null
	const openDiagramViewer = (frame, title) => {
		if (activeDiagramModal) activeDiagramModal.remove()

		const source = frame.querySelector(".mermaid, .diagram-fallback")
		if (!source) return
		const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

		const modal = document.createElement("div")
		modal.className = "diagram-modal"
		modal.setAttribute("role", "dialog")
		modal.setAttribute("aria-modal", "true")
		modal.setAttribute("aria-label", `${title} diagram viewer`)
		modal.innerHTML = `
			<div class="diagram-modal-bar">
				<strong>${title}</strong>
				<span class="diagram-modal-help">Scroll to zoom, drag to pan</span>
				<div class="diagram-modal-actions">
					<button type="button" data-diagram-zoom="out" aria-label="Zoom out">-</button>
					<button type="button" data-diagram-zoom="reset" aria-label="Reset zoom">100%</button>
					<button type="button" data-diagram-zoom="in" aria-label="Zoom in">+</button>
					<button type="button" data-diagram-close aria-label="Close diagram">Close</button>
				</div>
			</div>
			<div class="diagram-modal-stage">
				<div class="diagram-modal-canvas"></div>
			</div>
		`

		const stage = modal.querySelector(".diagram-modal-stage")
		const canvas = modal.querySelector(".diagram-modal-canvas")
		canvas.append(source.cloneNode(true))
		document.body.append(modal)
		document.body.classList.add("has-diagram-modal")
		activeDiagramModal = modal

		let scale = 1
		let x = 0
		let y = 0
		let dragging = false
		let startX = 0
		let startY = 0
		let originX = 0
		let originY = 0
		let dragMoved = false
		let lastDragEndedAt = 0
		let backdropClickCandidate = false
		let backdropStartX = 0
		let backdropStartY = 0
		const backdropClickThreshold = 6
		const diagramContentSelector = ".diagram-modal-canvas > .mermaid, .diagram-modal-canvas > .diagram-fallback"
		const zoomLabel = modal.querySelector("[data-diagram-zoom='reset']")
		const minScale = 0.35
		const maxScale = 4
		const fitPadding = 40
		const applyTransform = () => {
			canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
			if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`
		}
		const clampScale = (value) => Math.min(maxScale, Math.max(minScale, Number(value.toFixed(3))))
		const fitToStage = () => {
			const stageRect = stage.getBoundingClientRect()
			const contentWidth = canvas.offsetWidth
			const contentHeight = canvas.offsetHeight
			if (!contentWidth || !contentHeight) return
			const availableWidth = Math.max(1, stageRect.width - fitPadding * 2)
			const availableHeight = Math.max(1, stageRect.height - fitPadding * 2)
			scale = clampScale(Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight))
			x = (stageRect.width - contentWidth * scale) / 2
			y = (stageRect.height - contentHeight * scale) / 2
			applyTransform()
		}
		const stageCenter = () => {
			const rect = stage.getBoundingClientRect()
			return {
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
			}
		}
		const zoomTo = (nextScale, anchor = stageCenter()) => {
			nextScale = clampScale(nextScale)
			if (nextScale === scale) return
			const stageRect = stage.getBoundingClientRect()
			const anchorX = anchor.clientX - stageRect.left
			const anchorY = anchor.clientY - stageRect.top
			const localX = (anchorX - canvas.offsetLeft - x) / scale
			const localY = (anchorY - canvas.offsetTop - y) / scale
			x = anchorX - canvas.offsetLeft - localX * nextScale
			y = anchorY - canvas.offsetTop - localY * nextScale
			scale = nextScale
			applyTransform()
		}
		const zoomBy = (factor, anchor) => zoomTo(scale * factor, anchor)
		const reset = () => fitToStage()
		const focusableSelector = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
		const close = () => {
			modal.remove()
			document.body.classList.remove("has-diagram-modal")
			if (activeDiagramModal === modal) activeDiagramModal = null
			document.removeEventListener("keydown", onKeydown)
			window.removeEventListener("resize", fitToStage)
			if (returnFocus && document.contains(returnFocus)) returnFocus.focus()
		}
		const onKeydown = (event) => {
			if (event.key === "Escape") close()
			if (event.key === "Tab") {
				const focusable = Array.from(modal.querySelectorAll(focusableSelector)).filter((element) => !element.hasAttribute("disabled") && element instanceof HTMLElement)
				if (!focusable.length) return
				const first = focusable[0]
				const last = focusable[focusable.length - 1]
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault()
					first.focus()
				}
			}
			if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
				event.preventDefault()
				zoomBy(1.18)
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "-") {
				event.preventDefault()
				zoomBy(1 / 1.18)
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "0") {
				event.preventDefault()
				reset()
			}
		}

		modal.querySelector("[data-diagram-close]").addEventListener("click", close)
		modal.querySelector("[data-diagram-zoom='in']").addEventListener("click", () => zoomBy(1.18))
		modal.querySelector("[data-diagram-zoom='out']").addEventListener("click", () => zoomBy(1 / 1.18))
		modal.querySelector("[data-diagram-zoom='reset']").addEventListener("click", reset)
		modal.addEventListener("click", (event) => {
			const target = event.target
			if (!(target instanceof Element)) return
			if (Date.now() - lastDragEndedAt < 200) return
			if (target.closest(`${diagramContentSelector}, .diagram-modal-actions`)) return
			close()
		})
		stage.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault()
				const normalizedDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY
				const boundedDelta = Math.max(-220, Math.min(220, normalizedDelta))
				const factor = Math.exp(-boundedDelta * 0.0007)
				zoomBy(factor, { clientX: event.clientX, clientY: event.clientY })
			},
			{ passive: false }
		)
		stage.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return
			event.preventDefault()
			backdropClickCandidate = event.target instanceof Element && !event.target.closest(diagramContentSelector)
			backdropStartX = event.clientX
			backdropStartY = event.clientY
			dragMoved = false
			dragging = true
			stage.setPointerCapture(event.pointerId)
			startX = event.clientX
			startY = event.clientY
			originX = x
			originY = y
			stage.classList.add("is-dragging")
		})
		stage.addEventListener("pointermove", (event) => {
			if (!dragging) return
			event.preventDefault()
			const dragDistance = Math.hypot(event.clientX - backdropStartX, event.clientY - backdropStartY)
			if (dragDistance > backdropClickThreshold) {
				dragMoved = true
				backdropClickCandidate = false
			}
			x = originX + event.clientX - startX
			y = originY + event.clientY - startY
			applyTransform()
		})
		const stopDragging = (event) => {
			const shouldCloseFromBackdrop = backdropClickCandidate && !dragMoved
			if (dragMoved) lastDragEndedAt = Date.now()
			backdropClickCandidate = false
			dragMoved = false
			dragging = false
			stage.classList.remove("is-dragging")
			if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
			if (shouldCloseFromBackdrop) close()
		}
		stage.addEventListener("pointerup", stopDragging)
		stage.addEventListener("pointercancel", stopDragging)
		document.addEventListener("keydown", onKeydown)
		window.addEventListener("resize", fitToStage)
		modal.querySelector("[data-diagram-close]").focus()
		fitToStage()
	}

	const enhanceMermaidSvg = (svg) => {
		if (!svg) return
		const softenRect = (rect, radius) => {
			const rx = rect.getAttribute("rx")
			const ry = rect.getAttribute("ry")
			if (!rx || rx === "0") rect.setAttribute("rx", radius)
			if (!ry || ry === "0") rect.setAttribute("ry", radius)
		}
		svg.dataset.styled = "true"
		svg.querySelectorAll(".node, .state, .actor").forEach((node) => {
			node.querySelectorAll("rect").forEach((rect) => softenRect(rect, "6"))
		})
		svg.querySelectorAll(".cluster rect, .note, .labelBox, .edgeLabel rect").forEach((rect) => softenRect(rect, "5"))
	}

	const installMermaidDiagrams = async () => {
		const blocks = Array.from(document.querySelectorAll(".doc-article pre > code.language-mermaid"))
		if (!blocks.length) return

		const diagrams = blocks.map((code, index) => {
			const source = code.textContent || ""
			const pre = code.closest("pre")
			const frame = document.createElement("figure")
			frame.className = "mermaid-frame"
			const caption = document.createElement("figcaption")
			const captionText = detectDiagramType(source)
			const captionLabel = document.createElement("span")
			captionLabel.textContent = captionText
			const openButton = document.createElement("button")
			openButton.type = "button"
			openButton.className = "diagram-open-button"
			setIconLabel(openButton, icons.expand, "Full screen")
			openButton.setAttribute("aria-label", `Open ${captionText} diagram full screen`)
			const openDiagram = () => openDiagramViewer(frame, captionText)
			openButton.addEventListener("click", openDiagram)
			caption.append(captionLabel, openButton)
			const canvas = document.createElement("div")
			canvas.className = "diagram-fallback"
			canvas.dataset.diagramIndex = String(index)
			canvas.setAttribute("role", "button")
			canvas.setAttribute("tabindex", "0")
			canvas.setAttribute("aria-label", `Open ${captionText} diagram full screen`)
			canvas.addEventListener("click", (event) => {
				if (event.target.closest("button, a")) return
				openDiagram()
			})
			canvas.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return
				event.preventDefault()
				openDiagram()
			})
			fillFallbackDiagram(canvas, source)
			frame.append(caption, canvas)
			if (pre) pre.replaceWith(frame)
			return { frame, canvas, source }
		})

		if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
			diagrams.forEach(({ frame }) => frame.classList.add("is-fallback"))
			return
		}

		try {
			const module = await import("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs")
			const mermaid = module.default || module
			const mermaidTheme = root.dataset.theme === "dark"
				? {
						background: "#0b0f0e",
						mainBkg: "#241816",
						primaryColor: "#241816",
						primaryBorderColor: "#ff8f83",
						primaryTextColor: "#f1f7f4",
						secondaryColor: "#241816",
						secondaryBorderColor: "#ff8f83",
						secondaryTextColor: "#f1f7f4",
						tertiaryColor: "#292512",
						tertiaryBorderColor: "#e7c965",
						tertiaryTextColor: "#f1f7f4",
						lineColor: "#aaa29d",
						textColor: "#f1f7f4",
						nodeTextColor: "#f1f7f4",
						clusterBkg: "#121110",
						clusterBorder: "#5d4742",
						edgeLabelBackground: "#15110f",
						actorBkg: "#241816",
						actorBorder: "#ff8f83",
						actorTextColor: "#f1f7f4",
						actorLineColor: "#aaa29d",
						noteBkgColor: "#292512",
						noteTextColor: "#f1f7f4",
						noteBorderColor: "#e7c965",
						labelBoxBkgColor: "#292512",
						labelBoxBorderColor: "#e7c965",
						labelTextColor: "#f1f7f4",
						loopTextColor: "#f1f7f4",
					}
				: {
						background: "#ffffff",
						mainBkg: "#fff1ef",
						primaryColor: "#fff1ef",
						primaryBorderColor: "#ff6f61",
						primaryTextColor: "#0a0a0a",
						secondaryColor: "#fff1ef",
						secondaryBorderColor: "#ff6f61",
						secondaryTextColor: "#0a0a0a",
						tertiaryColor: "#fff7dc",
						tertiaryBorderColor: "#9d6b00",
						tertiaryTextColor: "#0a0a0a",
						lineColor: "#6f6f6f",
						textColor: "#0a0a0a",
						nodeTextColor: "#0a0a0a",
						clusterBkg: "#fafafa",
						clusterBorder: "#bdbdbd",
						edgeLabelBackground: "#ffffff",
						actorBkg: "#f5f5f5",
						actorBorder: "#bdbdbd",
						actorTextColor: "#0a0a0a",
						actorLineColor: "#6f6f6f",
						noteBkgColor: "#fff7dc",
						noteTextColor: "#0a0a0a",
						noteBorderColor: "#9d6b00",
						labelBoxBkgColor: "#fff7dc",
						labelBoxBorderColor: "#9d6b00",
						labelTextColor: "#0a0a0a",
						loopTextColor: "#0a0a0a",
					}
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "loose",
				theme: "base",
				themeVariables: mermaidTheme,
				flowchart: { htmlLabels: true },
			})
			const staging = document.createElement("div")
			staging.className = "mermaid-staging"
			document.body.append(staging)
			const renderNodes = diagrams.map(({ source }, index) => {
				const node = document.createElement("div")
				node.className = "mermaid"
				node.id = `mermaid-render-${Date.now()}-${index}`
				node.textContent = source
				staging.append(node)
				return node
			})
			await mermaid.run({ nodes: renderNodes, suppressErrors: true })
			renderNodes.forEach((node, index) => {
				const { frame, canvas, source } = diagrams[index]
				const svg = node.querySelector("svg")
				if (svg) {
					const renderedSvg = svg.cloneNode(true)
					enhanceMermaidSvg(renderedSvg)
					canvas.className = "mermaid"
					canvas.replaceChildren(renderedSvg)
					frame.classList.add("is-rendered")
				} else {
					frame.classList.add("is-fallback")
					fillFallbackDiagram(canvas, source)
				}
			})
			staging.remove()
		} catch (_error) {
			diagrams.forEach(({ frame }) => frame.classList.add("is-fallback"))
		}
	}

	installMermaidDiagrams()

	const formatAmount = (value) =>
		new Intl.NumberFormat("en-US", { maximumFractionDigits: 6, minimumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value)
	const readNumber = (rootElement, selector) => {
		const input = rootElement.querySelector(selector)
		const value = input ? Number(input.value) : 0
		return Number.isFinite(value) ? value : 0
	}
	const formatDuration = (seconds) => {
		const rounded = Math.max(0, Math.round(seconds))
		const hours = Math.floor(rounded / 3600)
		const minutes = Math.floor((rounded % 3600) / 60)
		const remainingSeconds = rounded % 60
		const parts = []
		if (hours) parts.push(`${hours}h`)
		if (minutes) parts.push(`${minutes}m`)
		if (remainingSeconds || !parts.length) parts.push(`${remainingSeconds}s`)
		return parts.join(" ")
	}
	const installExpressFundingTool = (mount) => {
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Context helper</p>
					<h3>Offer Eligibility & Funding</h3>
				</div>
				<p>Enter the user's request, pool balances, and credit config to see which offers the bot can sign and where capital is drawn from.</p>
			</div>
			<div class="tool-input-groups">
				<div class="tool-input-group">
					<strong>Request</strong>
					<div class="tool-grid tool-grid-compact">
						<label>User requested amount<input type="number" min="0" step="0.01" value="500" data-request-amount></label>
						<label>Risk check<select data-risk-check>
							<option value="LOW">LOW RISK</option>
							<option value="HIGH">HIGH RISK</option>
						</select></label>
						<label>Min validator signatures<input type="number" min="0" step="1" value="2" data-validator-count></label>
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Available liquidity</strong>
					<div class="tool-grid tool-grid-compact">
						<label>Affiliate pool free<input type="number" min="0" step="0.01" value="120" data-affiliate-pool></label>
						<label>General pool free<input type="number" min="0" step="0.01" value="300" data-general-pool></label>
						<label>Muon eligible base<input type="number" min="0" step="0.01" value="2000" data-eligible-base></label>
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Credit line config</strong>
					<div class="tool-grid tool-grid-compact">
						<label>Current debt<input type="number" min="0" step="0.01" value="300" data-current-debt></label>
						<label>Protocol max debt<input type="number" min="0" step="0.01" value="1000" data-protocol-max-debt></label>
						<label>Affiliate max debt<input type="number" min="0" step="0.01" value="700" data-affiliate-max-debt></label>
						<label>Protocol max bps<input type="number" min="0" max="10000" step="1" value="5000" data-protocol-max-bps></label>
						<label>Affiliate max bps<input type="number" min="0" max="10000" step="1" value="3000" data-affiliate-max-bps></label>
						<label>Credit blocked?<select data-credit-blocked>
							<option value="NO">No</option>
							<option value="PAUSED">Paused</option>
							<option value="BLACKLISTED">User blacklisted</option>
						</select></label>
					</div>
				</div>
				<div class="tool-input-group">
					<strong>Fees</strong>
					<div class="tool-grid tool-grid-compact">
						<label>Affiliate fee bps<input type="number" min="0" max="10000" step="1" value="80" data-fee-bps></label>
						<label>Operator fee<input type="number" min="0" step="0.01" value="1" data-operator-fee></label>
					</div>
				</div>
			</div>
			<div class="tool-result" aria-live="polite"></div>
		`
		const result = mount.querySelector(".tool-result")
		const cappedLimit = (values) => {
			const positive = values.filter((value) => value > 0)
			return positive.length ? Math.min(...positive) : Infinity
		}
		const describeLimit = (value) => Number.isFinite(value) ? formatAmount(value) : "uncapped by config"
		const allocateFastFunding = (amount, affiliatePool, generalPool, creditCapacity, allowCredit = true) => {
			const affiliateAmount = Math.min(amount, affiliatePool)
			let remaining = Math.max(0, amount - affiliateAmount)
			const creditAmount = allowCredit ? Math.min(remaining, creditCapacity) : 0
			remaining = Math.max(0, remaining - creditAmount)
			const generalAmount = Math.min(remaining, generalPool)
			remaining = Math.max(0, remaining - generalAmount)
			return { affiliateAmount, creditAmount, generalAmount, unfunded: remaining }
		}
		const optionCard = (option) => `
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
				</div>
			</article>
		`
		const update = () => {
			const requestAmount = readNumber(mount, "[data-request-amount]")
			const riskCheck = mount.querySelector("[data-risk-check]").value
			const validatorCount = readNumber(mount, "[data-validator-count]")
			const affiliatePool = readNumber(mount, "[data-affiliate-pool]")
			const generalPool = readNumber(mount, "[data-general-pool]")
			const eligibleBase = readNumber(mount, "[data-eligible-base]")
			const currentDebt = readNumber(mount, "[data-current-debt]")
			const protocolMaxDebt = readNumber(mount, "[data-protocol-max-debt]")
			const affiliateMaxDebt = readNumber(mount, "[data-affiliate-max-debt]")
			const protocolMaxBps = readNumber(mount, "[data-protocol-max-bps]")
			const affiliateMaxBps = readNumber(mount, "[data-affiliate-max-bps]")
			const creditBlocked = mount.querySelector("[data-credit-blocked]").value
			const feeBps = readNumber(mount, "[data-fee-bps]")
			const operatorFee = readNumber(mount, "[data-operator-fee]")

			const protocolBpsLimit = protocolMaxBps > 0 ? eligibleBase * protocolMaxBps / 10000 : Infinity
			const affiliateBpsLimit = affiliateMaxBps > 0 ? eligibleBase * affiliateMaxBps / 10000 : Infinity
			const effectiveDebtLimit = cappedLimit([protocolMaxDebt, affiliateMaxDebt, protocolBpsLimit, affiliateBpsLimit])
			const creditBlockedReason = creditBlocked === "PAUSED" ? "credit line is paused" : creditBlocked === "BLACKLISTED" ? "user is blacklisted for credit" : ""
			const rawCreditCapacity = Number.isFinite(effectiveDebtLimit) ? Math.max(0, effectiveDebtLimit - currentDebt) : requestAmount
			const creditCapacity = creditBlocked === "NO" ? rawCreditCapacity : 0
			const fastAllocation = allocateFastFunding(requestAmount, affiliatePool, generalPool, creditCapacity)
			const standardAllocation = { affiliateAmount: 0, creditAmount: 0, generalAmount: 0, unfunded: 0 }

			const feeAmount = requestAmount * feeBps / 10000
			const totalFee = feeAmount + operatorFee
			const userFee = totalFee
			const netUserAmount = Math.max(0, requestAmount - userFee)
			const poolDraw = fastAllocation.affiliateAmount + fastAllocation.generalAmount
			const validatorsReady = validatorCount > 0
			const fastFundingAvailable = requestAmount > 0 && fastAllocation.unfunded <= 0

			const sameTxReasons = []
			if (!validatorsReady) sameTxReasons.push("validator signatures are not configured")
			if (!fastFundingAvailable) sameTxReasons.push(`${formatAmount(fastAllocation.unfunded)} remains unfunded after pools and credit`)
			if (creditBlockedReason && fastAllocation.unfunded > 0) sameTxReasons.push(creditBlockedReason)
			const windowedReasons = []
			if (riskCheck !== "LOW") windowedReasons.push("risk check is high, so the bot should not sign the fast path")
			if (!fastFundingAvailable) windowedReasons.push(`${formatAmount(fastAllocation.unfunded)} remains unfunded after pools and credit`)
			if (creditBlockedReason && fastAllocation.unfunded > 0) windowedReasons.push(creditBlockedReason)

			const options = [
				{
					type: "SAME_TX",
					available: validatorsReady && fastFundingAvailable,
					reason: sameTxReasons.length ? sameTxReasons.join("; ") : "Same-transaction payout can be signed because validators are configured and the request can be fully funded.",
					allocation: fastAllocation,
				},
				{
					type: "WINDOWED",
					available: riskCheck === "LOW" && fastFundingAvailable,
					reason: windowedReasons.length ? windowedReasons.join("; ") : "The request can be processed after the security window using the computed pool and credit split.",
					allocation: fastAllocation,
				},
				{
					type: "STANDARD",
					available: requestAmount > 0,
					reason: requestAmount > 0 ? "Always available as the cooldown path; Express does not front pools or credit for STANDARD." : "Enter a positive request amount.",
					allocation: standardAllocation,
				},
			]
			const recommended = options.find((option) => option.available) || options[2]
			const warnings = []
			if (creditBlockedReason) warnings.push(`Credit capacity is zero because ${creditBlockedReason}.`)
			if (requestAmount > 0 && fastAllocation.unfunded > 0) warnings.push("Fast options cannot cover the full request with the current pools and credit capacity; STANDARD remains the fallback.")
			if (!validatorsReady) warnings.push("SAME_TX requires minValidatorSignatures above zero.")
			if (riskCheck !== "LOW") warnings.push("WINDOWED should not be signed while the risk check is high.")
			result.innerHTML = `
				<div class="result-metrics">
					<span><small>Recommended offer</small><strong>${escapeHtml(recommended.type)}</strong></span>
					<span><small>Fast pool draw</small><strong>${formatAmount(poolDraw)}</strong></span>
					<span><small>Credit capacity</small><strong>${formatAmount(creditCapacity)}</strong></span>
					<span><small>User receives after fees</small><strong>${formatAmount(netUserAmount)}</strong></span>
				</div>
				<div class="option-card-grid">${options.map(optionCard).join("")}</div>
				<p>Effective credit cap is <strong>${describeLimit(effectiveDebtLimit)}</strong>; current debt is <strong>${formatAmount(currentDebt)}</strong>; usable credit for this request is <strong>${formatAmount(creditCapacity)}</strong>.</p>
				<p>Fee is <strong>${formatAmount(feeAmount)}</strong> plus operator fee <strong>${formatAmount(operatorFee)}</strong>; user pays <strong>${formatAmount(userFee)}</strong>.</p>
				${warnings.length ? `<ul class="tool-warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : '<p class="tool-ok">Current config supports a fast offer and a standard fallback.</p>'}
			`
		}
		mount.querySelectorAll("input, select").forEach((control) => {
			control.addEventListener("input", update)
			control.addEventListener("change", update)
		})
		update()
	}

	const installExpressTimingTool = (mount) => {
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Context helper</p>
					<h3>Processing Timeline</h3>
				</div>
				<p>Model operator, permissionless, and STANDARD finalization windows.</p>
			</div>
			<div class="tool-grid tool-grid-compact">
				<label>Security window (seconds)<input type="number" min="0" step="1" value="20" data-security-window></label>
				<label>Tolerance period (seconds)<input type="number" min="0" step="1" value="60" data-tolerance-period></label>
				<label>STANDARD cooldown (hours)<input type="number" min="0" step="0.25" value="12" data-standard-cooldown></label>
			</div>
			<div class="timeline-track" aria-live="polite"></div>
		`
		const result = mount.querySelector(".timeline-track")
		const update = () => {
			const securityWindow = readNumber(mount, "[data-security-window]")
			const tolerancePeriod = readNumber(mount, "[data-tolerance-period]")
			const cooldown = readNumber(mount, "[data-standard-cooldown]") * 3600
			const permissionless = securityWindow + tolerancePeriod
			result.innerHTML = `
				<div class="timeline-item"><span>Accept</span><strong>T + 0s</strong><small>Request enters ExpressProvider state.</small></div>
				<div class="timeline-item"><span>Operator</span><strong>T + ${formatDuration(securityWindow)}</strong><small>Operator can process WINDOWED if not locked.</small></div>
				<div class="timeline-item"><span>Fallback</span><strong>T + ${formatDuration(permissionless)}</strong><small>Anyone can process after tolerance expires.</small></div>
				<div class="timeline-item"><span>STANDARD</span><strong>T + ${formatDuration(cooldown)}</strong><small>SYMMIO cooldown target before finalization.</small></div>
			`
		}
		mount.querySelectorAll("input").forEach((control) => control.addEventListener("input", update))
		update()
	}
	const installExpressTools = () => {
		document.querySelectorAll("[data-express-funding-tool]").forEach(installExpressFundingTool)
		document.querySelectorAll("[data-express-timing-tool]").forEach(installExpressTimingTool)
	}

	installExpressTools()

	// ── Execution-context bit lab ─────────────────────────────────────────────
	// A deliberately literal port of contracts/core/libraries/LibExecutionContext.sol.
	// Every panel on execution-context-bit-lab.html reads its numbers from these
	// helpers rather than from prose, so a reader can compare the rendered word
	// against the contract line quoted beside it.

	const bitMask = (index) => 1n << BigInt(index)
	const INSTANT_CONTEXT_ACTIVE = bitMask(0)
	const CALL_FROM_INSTANT_LAYER = bitMask(1)
	const INSTANT_OPEN_MODE = bitMask(2)
	const INSTANT_CONTEXT_FLAGS = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER | INSTANT_OPEN_MODE
	const SNAPSHOT_ACTIVE = bitMask(255)
	const SNAPSHOT_TRANSIENT = bitMask(254)
	const SNAPSHOT_PERSISTENT_CALL = bitMask(1)
	const SNAPSHOT_PERSISTENT_OPEN = bitMask(2)

	// The only five positions any of these words ever uses.
	const TRACKED_BITS = [255, 254, 2, 1, 0]
	const BIT_LABELS = {
		255: { short: "SNAPSHOT_ACTIVE", live: null, snapshot: "This is a real snapshot, not the 0 sentinel." },
		254: { short: "SNAPSHOT_TRANSIENT", live: null, snapshot: "The suspended authority came from transient storage." },
		2: { short: "INSTANT_OPEN_MODE", live: "InstantOpen accounting mode is enabled.", snapshot: "Suspended InstantOpen accounting-mode flag." },
		1: { short: "CALL_FROM_INSTANT_LAYER", live: "This call is routed by InstantLayer.", snapshot: "Suspended routing flag." },
		0: {
			short: "INSTANT_CONTEXT_ACTIVE",
			live: "A scope is open. Zero here is what makes every reader fall back.",
			snapshot: "Inherited from the live word and restored with bits 1–2; bit 254, not bit 0, selects the restoration source.",
		},
	}

	const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
	const SIGNER_ADDRESS = "0x00000000000000000000000000000000000000D4"
	const ATTACKER_ADDRESS = "0x00000000000000000000000000000000000000EE"

	const isBitSet = (word, index) => (word & bitMask(index)) !== 0n
	const toFullHex = (word) => `0x${word.toString(16).padStart(64, "0")}`
	const toShortHex = (word) => {
		const hex = word.toString(16).padStart(64, "0")
		if (/^0+$/.test(hex)) return "0x00"
		return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`
	}
	const changedBits = (before, after) => TRACKED_BITS.filter((index) => isBitSet(before, index) !== isBitSet(after, index))
	const setBitsOf = (word) => TRACKED_BITS.filter((index) => isBitSet(word, index))

	// Renders one 256-bit word as five meaningful cells plus a collapsed middle.
	const renderWordStrip = (word, options = {}) => {
		const { interactive = false, kind = "live", changed = [], middle = "zero" } = options
		const cell = (index) => {
			const on = isBitSet(word, index)
			const classes = ["bit-cell"]
			if (on) classes.push("is-set")
			if (changed.includes(index)) classes.push("is-changed")
			if (interactive) classes.push("is-interactive")
			const meaning = BIT_LABELS[index][kind === "snapshot" ? "snapshot" : "live"]
			const title = meaning ? `bit ${index} — ${BIT_LABELS[index].short}: ${meaning}` : `bit ${index} — unused in a ${kind} word`
			const tag = interactive ? "button" : "div"
			const attributes = interactive
				? ` type="button" data-bit="${index}" aria-label="${escapeHtml(`${title}. Current value ${on ? 1 : 0}; activate to set ${on ? 0 : 1}.`)}" aria-pressed="${on}"`
				: ""
			return `<${tag} class="${classes.join(" ")}"${attributes} title="${escapeHtml(title)}"><small>${index}</small><b>${on ? "1" : "0"}</b></${tag}>`
		}
		const middleLabel = middle === "ones" ? "bits 253…3 · all one" : "bits 253…3 · all zero"
		return `
			<div class="bit-strip">
				${cell(255)}${cell(254)}
				<div class="bit-gap ${middle === "ones" ? "is-ones" : ""}"><span>${middleLabel}</span></div>
				${cell(2)}${cell(1)}${cell(0)}
			</div>
		`
	}

	const renderWordCard = (word, options = {}) => {
		const { label, sublabel = "", kind = "live", changed = [], interactive = false, middle = "zero" } = options
		const set = setBitsOf(word)
		const legend = set.length
			? set
					.map(
						(index) =>
							`<span class="bit-tag ${changed.includes(index) ? "is-changed" : ""}">bit ${index} <code>${BIT_LABELS[index].short}</code></span>`
					)
					.join("")
			: `<span class="bit-tag is-empty">no bits set — the word is <code>0</code></span>`
		return `
			<div class="bit-word ${changed.length ? "is-touched" : ""}">
				<div class="bit-word-head">
					<span class="bit-word-name">${label}${sublabel ? ` <small>${sublabel}</small>` : ""}</span>
					<span class="bit-word-value" title="${toFullHex(word)}"><code>${toShortHex(word)}</code><small>${word === 0n ? "0" : `0b${word & INSTANT_CONTEXT_FLAGS ? (word & INSTANT_CONTEXT_FLAGS).toString(2).padStart(3, "0") : "000"} in the low bits`}</small></span>
				</div>
				${renderWordStrip(word, { kind, changed, interactive, middle })}
				<div class="bit-legend">${legend}</div>
			</div>
		`
	}

	// One word holding an address rather than flags: bits 159-0 are the value.
	const renderAddressWord = (address, options = {}) => {
		const { label, sublabel = "", changed = false } = options
		const empty = address === ZERO_ADDRESS
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
		`
	}

	const renderMarkerWord = (marker, options = {}) => {
		const { label, sublabel = "", changed = false } = options
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
		`
	}

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
	]

	const installWordReaderTool = (mount) => {
		const scope = mount.dataset.wordReaderTool === "snapshot" ? "snapshot" : "live"
		const presets = WORD_PRESETS.filter((preset) => preset.kind === scope)
		const initial = scope === "snapshot" ? 0 : presets.length - 1
		let word = presets[initial].value
		let kind = scope
		const headingId = `execution-context-${scope}-word-tool-title`
		mount.setAttribute("aria-labelledby", headingId)
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
				<div class="bit-readout" data-readout aria-live="polite"></div>
			</div>
		`
		const wordMount = mount.querySelector("[data-word-mount]")
		const readout = mount.querySelector("[data-readout]")
		const render = () => {
			wordMount.innerHTML = renderWordCard(word, {
				label: kind === "snapshot" ? "Snapshot word" : "Live context word",
				sublabel: kind === "snapshot" ? "returned by suspend, never stored live" : "TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT",
				kind,
				interactive: scope === "live",
			})
			wordMount.querySelectorAll("[data-bit]").forEach((button) => {
				button.addEventListener("click", () => {
					word ^= bitMask(Number(button.dataset.bit))
					render()
				})
			})
			mount.querySelectorAll("[data-preset]").forEach((button) => {
				const preset = presets[Number(button.dataset.preset)]
				const selected = preset.kind === kind && preset.value === word
				button.classList.toggle("is-active", selected)
				button.setAttribute("aria-pressed", String(selected))
			})
			const rows = []
			rows.push(`<div class="bit-readout-row"><span>Full hex</span><code class="is-wide">${toFullHex(word)}</code></div>`)
			rows.push(`<div class="bit-readout-row"><span>As the code writes it</span><code>${describeWordAsSource(word, kind)}</code></div>`)
			if (kind === "live") {
				const active = (word & INSTANT_CONTEXT_ACTIVE) !== 0n
				rows.push(
					`<div class="bit-readout-row"><span><code>isTransientContextActive()</code></span><strong class="${active ? "is-true" : "is-false"}">${active}</strong></div>`
				)
				rows.push(
					`<div class="bit-readout-row"><span><code>isCallFromInstantLayer()</code></span><strong class="${active && (word & CALL_FROM_INSTANT_LAYER) !== 0n ? "is-true" : "is-false"}">${
						active ? (word & CALL_FROM_INSTANT_LAYER) !== 0n : "falls back to storage"
					}</strong></div>`
				)
				rows.push(
					`<div class="bit-readout-row"><span><code>isInstantOpenMode()</code></span><strong class="${active && (word & INSTANT_OPEN_MODE) !== 0n ? "is-true" : "is-false"}">${
						active ? (word & INSTANT_OPEN_MODE) !== 0n : "falls back to storage"
					}</strong></div>`
				)
			}
			const warning = describeWordWarning(word, kind)
			readout.innerHTML = `${rows.join("")}${warning ? `<p class="bit-warn">${warning}</p>` : ""}`
		}
		mount.querySelectorAll("[data-preset]").forEach((button) => {
			button.addEventListener("click", () => {
				const preset = presets[Number(button.dataset.preset)]
				word = preset.value
				kind = preset.kind
				render()
			})
		})
		render()
	}

	const describeWordAsSource = (word, kind) => {
		const parts = []
		if (kind === "snapshot") {
			if (isBitSet(word, 255)) parts.push("EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE")
			if (isBitSet(word, 254)) parts.push("EXTERNAL_CONTEXT_SNAPSHOT_TRANSIENT")
		}
		if (isBitSet(word, 2))
			parts.push(kind === "snapshot" && !isBitSet(word, 254) ? "EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_OPEN" : "INSTANT_OPEN_MODE")
		if (isBitSet(word, 1))
			parts.push(kind === "snapshot" && !isBitSet(word, 254) ? "EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_CALL" : "CALL_FROM_INSTANT_LAYER")
		if (isBitSet(word, 0)) parts.push("INSTANT_CONTEXT_ACTIVE")
		return parts.length ? parts.join(" | ") : "0"
	}

	const describeWordWarning = (word, kind) => {
		if (kind === "live" && word !== 0n && !isBitSet(word, 0)) {
			return "No reader can ever see this. With bit 0 clear, <code>isCallFromInstantLayer</code> and <code>isInstantOpenMode</code> both skip the word entirely and read the persistent field, so bits 1 and 2 are dead here."
		}
		if (kind === "snapshot" && word !== 0n && !isBitSet(word, 255)) {
			return "<code>restoreExecutionContextAfterExternalCall</code> rejects this with <code>ExternalCallContextNotSuspended</code>: a non-zero value without bit 255 was never produced by suspend."
		}
		if (kind === "snapshot" && isBitSet(word, 254) && !isBitSet(word, 0)) {
			return "Malformed and unreachable: a transient snapshot copies a live word whose bit 0 is set. Restore would accept this shape but rebuild a non-active word that the normal lifecycle cannot close."
		}
		return ""
	}

	// ── Panel 2: the batch lifecycle, slot by slot ───────────────────────────
	const LIB = "LibExecutionContext.sol"

	const buildLifecycle = ({ mechanism, hook }) => {
		const transient = mechanism === "transient"
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
		}
		const steps = []
		let halted = false
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
				})
				return
			}
			const before = { ...state }
			const outcome = mutate ? mutate() || {} : {}
			if (outcome.revert) halted = true
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
			})
		}

		if (transient) {
			record(
				{
					actor: "InstantLayer",
					call: "beginInstantLayerExecution(true)",
					source: `${LIB} · L124`,
					detail: "Refuses to open over another live scope, then builds the word: bit 0 selects transient context, bit 1 enables routing, and bit 2 enables InstantOpen accounting. The native path uses one <code>tstore</code> here.",
				},
				() => {
					state.context = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER | INSTANT_OPEN_MODE
				}
			)
			record(
				{
					actor: "Authorized router",
					call: "setTransientSigner(0x…D4)",
					source: `${LIB} · L208`,
					detail: "Value and marker move together. The marker is what tells later readers that transient storage — not the persistent <code>signer</code> field — owns this identity.",
				},
				() => {
					state.signerValue = SIGNER_ADDRESS
					state.signerActive = 1
				}
			)
		} else {
			record(
				{
					actor: "Historical persistent-field fallback",
					call: "legacy persistent fields already set",
					source: "GlobalAppStorage · callFromInstantLayer, instantOpenMode, signer",
					detail: "The path begins with pre-existing persistent mode flags and a persistent signer. No transient scope is open, so the live word stays <code>0</code> and effective-value readers take the fallback branch.",
				},
				() => {}
			)
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
			() => ({ read: true })
		)

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
					state.heldSigner = state.signerValue
					state.heldWasTransient = true
					state.signerValue = ZERO_ADDRESS
					return {}
				}
				state.heldSigner = state.persistentSigner
				state.heldWasTransient = false
				state.persistentSigner = ZERO_ADDRESS
			}
		)

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
					state.heldSnapshot = SNAPSHOT_ACTIVE | SNAPSHOT_TRANSIENT | state.context
					state.context = 0n
					return {}
				}
				let snapshot = SNAPSHOT_ACTIVE
				if (state.persistentRouted) snapshot |= SNAPSHOT_PERSISTENT_CALL
				if (state.persistentOpen) snapshot |= SNAPSHOT_PERSISTENT_OPEN
				state.heldSnapshot = snapshot
				state.persistentRouted = false
				state.persistentOpen = false
				return {}
			}
		)

		const hookNote = {
			clean: "The hook finds no outer batch authority. With no configured signer, <code>signer()</code> falls back to the hook's own <code>msg.sender</code> context; it cannot act as the hidden outer signer.",
			signer: "This models a privileged or re-entrant callback path leaving a signer installed while the outer signer is suspended. An ordinary hook fails at the setter's role gate.",
			scope: "This models a privileged or re-entrant callback path opening an InstantLayer scope and leaving it active. An ordinary hook fails at the setter's role gate.",
		}
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
					state.signerValue = ATTACKER_ADDRESS
					state.signerActive = 1
				}
				if (hook === "scope") state.context = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER
			}
		)

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
				const snapshot = state.heldSnapshot
				if (snapshot === 0n) return { detail: "Nothing was suspended, so this is a no-op." }
				if ((snapshot & SNAPSHOT_ACTIVE) === 0n) return { revert: "ExternalCallContextNotSuspended" }
				if (state.context !== 0n || state.persistentRouted || state.persistentOpen) {
					return {
						revert: "ExternalCallContextWasModified",
						detail: "Restoration requires both context sources to be empty. Suspension cleared the active source, and entry guards required the inactive source to be empty already. Anything present now was installed by the hook, so restore fails closed.",
					}
				}
				if ((snapshot & SNAPSHOT_TRANSIENT) !== 0n) {
					state.context = snapshot & INSTANT_CONTEXT_FLAGS
					return {}
				}
				state.persistentRouted = (snapshot & SNAPSHOT_PERSISTENT_CALL) !== 0n
				state.persistentOpen = (snapshot & SNAPSHOT_PERSISTENT_OPEN) !== 0n
			}
		)

		record(
			{
				actor: "LibHook",
				call: `restoreSignerAfterExternalCall(0x…D4, ${state.heldWasTransient})`,
				source: `${LIB} · L242`,
				detail: "Both branches refuse to restore on top of a populated signer layer. The transient branch checks the two value sources but not the marker, because balanced nested trusted signer use may legitimately have cleared that shared marker.",
			},
			() => {
				const branchTransient = state.heldWasTransient
				if (branchTransient) {
					if (state.persistentSigner !== ZERO_ADDRESS || state.signerValue !== ZERO_ADDRESS) {
						return {
							revert: "ExternalCallSignerWasModified",
							detail: "The callback path left a signer in the transient value slot, so the guard fires and the whole transaction reverts. Authority cannot be smuggled across the boundary.",
						}
					}
					state.signerValue = state.heldSigner
					state.signerActive = 1
					return {}
				}
				if (state.persistentSigner !== ZERO_ADDRESS || state.signerActive || state.signerValue !== ZERO_ADDRESS) {
					return {
						revert: "ExternalCallSignerWasModified",
						detail: "The persistent branch also requires the marker to be clear: a set marker means the callback path opened a transient signer scope and left it active.",
					}
				}
				state.persistentSigner = state.heldSigner
			}
		)

		if (transient) {
			record(
				{
					actor: "Authorized router",
					call: "setTransientSigner(address(0))",
					source: `${LIB} · L208`,
					detail: "Passing zero ends the override rather than masking anything: value and marker both go to zero.",
				},
				() => {
					state.signerValue = ZERO_ADDRESS
					state.signerActive = 0
				}
			)
			record(
				{
					actor: "InstantLayer",
					call: "endInstantLayerExecution()",
					source: `${LIB} · L137`,
					detail: "Two guards before the write: the scope must exist, and no signer may still be installed. Ending with one alive would leave an identity every later call still reads, with no scope to attribute it to.",
				},
				() => {
					if ((state.context & INSTANT_CONTEXT_ACTIVE) === 0n) return { revert: "TransientContextNotActive" }
					if (state.signerActive) return { revert: "TransientSignerNotCleared" }
					state.context = 0n
				}
			)
		}
		return steps
	}

	const readerRow = (state) => {
		const active = (state.context & INSTANT_CONTEXT_ACTIVE) !== 0n
		const routed = active ? (state.context & CALL_FROM_INSTANT_LAYER) !== 0n : state.persistentRouted
		const open = active ? (state.context & INSTANT_OPEN_MODE) !== 0n : state.persistentOpen
		const signer = state.signerActive ? state.signerValue : state.persistentSigner
		const item = (name, value, branch) => `
			<div class="bit-reader">
				<code>${name}</code>
				<strong class="${value === true ? "is-true" : value === false ? "is-false" : ""}">${value === true ? "true" : value === false ? "false" : value}</strong>
				<small>${branch}</small>
			</div>
		`
		return `
			${item("isTransientContextActive()", active, "reads bit 0 only — never falls back")}
			${item("isCallFromInstantLayer()", routed, active ? "bit 0 set → answered from the word" : "bit 0 clear → persistent field")}
			${item("isInstantOpenMode()", open, active ? "bit 0 set → answered from the word" : "bit 0 clear → persistent field")}
			${item("configuredSigner()", signer === ZERO_ADDRESS ? "address(0)" : `${signer.slice(0, 6)}…${signer.slice(-4)}`, state.signerActive ? "marker set → transient value" : "marker clear → persistent field")}
		`
	}

	const installLifecycleTool = (mount) => {
		let mechanism = "transient"
		let hook = "clean"
		let cursor = 0
		let steps = buildLifecycle({ mechanism, hook })
		const headingId = "execution-context-lifecycle-tool-title"
		mount.setAttribute("aria-labelledby", headingId)
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">One batch lifecycle</p>
					<h4 id="${headingId}">From scope creation to final cleanup</h4>
				</div>
				<p>The default path follows a clean transient batch. Slot changes are outlined, and each reader recomputes from the current state.</p>
			</div>
			<div class="bit-body">
				<div class="bit-controls">
					<label>Mechanism<select data-mechanism>
						<option value="transient">Transient scope (current Cancun build)</option>
						<option value="persistent">Historical persistent-field fallback</option>
					</select></label>
					<label>Callback result<select data-hook>
						<option value="clean">Clean — leaves authority empty</option>
						<option value="signer">Privileged path leaves a signer</option>
						<option value="scope">Privileged path leaves a scope</option>
					</select></label>
				</div>
				<ol class="bit-timeline" data-timeline></ol>
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
					<p class="bit-stage-detail" data-detail></p>
					<div class="bit-slots" data-slots></div>
					<div class="bit-readers" data-readers></div>
				</div>
			</div>
		`
		const timeline = mount.querySelector("[data-timeline]")
		const render = () => {
			const step = steps[cursor]
			timeline.innerHTML = steps
				.map(
					(entry, index) => `
							<li class="${index === cursor ? "is-current" : ""} ${entry.revert ? "is-revert" : ""} ${entry.skipped ? "is-skipped" : ""} ${entry.untrusted ? "is-untrusted" : ""}">
								<button type="button" data-step="${index}"${index === cursor ? ' aria-current="step"' : ""}>
								<small>${entry.actor}</small>
								<span>${escapeHtml(entry.call)}</span>
							</button>
						</li>
					`
				)
				.join("")
			timeline.querySelectorAll("[data-step]").forEach((button) => {
				button.addEventListener("click", () => {
					cursor = Number(button.dataset.step)
					render()
				})
			})
			mount.querySelector("[data-actor]").textContent = step.untrusted ? `${step.actor} · external code` : step.actor
			mount.querySelector("[data-call]").innerHTML = `<code>${escapeHtml(step.call)}</code>`
			mount.querySelector("[data-source]").innerHTML = step.skipped
				? "Not reached — the transaction already reverted."
				: escapeHtml(step.source)
			mount.querySelector("[data-detail]").innerHTML = step.revert
				? `<span class="bit-revert">revert ${step.revert}</span> ${step.detail}`
				: step.detail
			const state = step.state
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
			`
			mount.querySelector("[data-readers]").innerHTML = readerRow(state)
			mount.querySelector("[data-prev]").disabled = cursor === 0
			mount.querySelector("[data-next]").disabled = cursor === steps.length - 1
		}
		const rebuild = () => {
			steps = buildLifecycle({ mechanism, hook })
			cursor = 0
			render()
		}
		mount.querySelector("[data-mechanism]").addEventListener("change", (event) => {
			mechanism = event.target.value
			rebuild()
		})
		mount.querySelector("[data-hook]").addEventListener("change", (event) => {
			hook = event.target.value
			rebuild()
		})
		mount.querySelector("[data-prev]").addEventListener("click", () => {
			cursor = Math.max(0, cursor - 1)
			render()
		})
		mount.querySelector("[data-next]").addEventListener("click", () => {
			cursor = Math.min(steps.length - 1, cursor + 1)
			render()
		})
		render()
	}

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
	]

	const installSlotAddressTool = (mount) => {
		const headingId = "execution-context-slot-tool-title"
		mount.setAttribute("aria-labelledby", headingId)
		mount.innerHTML = `
			<div class="tool-heading">
				<div>
					<p class="eyebrow">Caller-scoped snapshot</p>
					<h4 id="${headingId}">Each router receives a separate saved-context slot</h4>
				</div>
				<p>Core combines one namespace with <code>msg.sender</code>; the same namespace and different callers derive unrelated slots.</p>
			</div>
			<div class="bit-body">
				<pre class="bit-code"><code>keccak256(abi.encode(EXTERNAL_CALL_CONTEXT_NAMESPACE, caller))</code><small>${LIB} · L362</small></pre>
				<p class="bit-reading">The addresses are illustrative. Their different hashes are the isolation boundary between routers.</p>
				<div class="bit-slot-list">
					${CALLER_SLOTS.map(
						(caller) => `
							<div class="bit-slot">
								<div class="bit-slot-head"><code>${caller.label}</code><small>${caller.address}</small></div>
								<code class="is-wide">${caller.hash}</code>
							</div>
						`
					).join("")}
				</div>
			</div>
		`
	}

	const installBitLabTools = () => {
		document.querySelectorAll("[data-word-reader-tool]").forEach(installWordReaderTool)
		document.querySelectorAll("[data-context-lifecycle-tool]").forEach(installLifecycleTool)
		document.querySelectorAll("[data-slot-address-tool]").forEach(installSlotAddressTool)
	}

	installBitLabTools()

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
	])
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
	])
	const highlightSolidity = (source) => {
		let html = ""
		let index = 0
		const tokenPattern =
			/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b0x[a-fA-F0-9]+\b|\b\d+(?:_\d+)*(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
		for (const match of source.matchAll(tokenPattern)) {
			const token = match[0]
			html += escapeHtml(source.slice(index, match.index))
			let className = ""
			if (token.startsWith("//") || token.startsWith("/*")) className = "tok-comment"
			else if (token.startsWith("\"") || token.startsWith("'")) className = "tok-string"
			else if (/^(0x[a-fA-F0-9]+|\d)/.test(token)) className = "tok-number"
			else if (solidityKeywords.has(token)) className = "tok-keyword"
			else if (solidityTypes.has(token)) className = "tok-type"
			else if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) className = "tok-symbol"
			html += className ? `<span class="${className}">${escapeHtml(token)}</span>` : escapeHtml(token)
			index = match.index + token.length
		}
		html += escapeHtml(source.slice(index))
		return html
	}

	const looksLikeSolidity = (source) => {
		const trimmed = source.trim()
		if (!trimmed) return false
		const firstLine = trimmed.split("\n").find(Boolean) || ""
		if (/^(Scenario|Example|Bot sees|On withdrawal request|if user(?:-requested|\s+requested)|reserveDebt|activateDebt|settleDebt)\b/i.test(firstLine)) return false
		if (/[─→►]/.test(trimmed)) return false

		const strongSignals = [
			/\b(function|struct|enum|event|error|modifier|mapping|contract|interface|library|pragma|import)\b/,
			/\b(external|public|internal|private|payable|view|pure|returns|calldata|memory|storage|immutable|override)\b/,
			/\b(uint(?:8|16|24|32|64|128|160|256)?|int(?:8|16|32|64|128|256)?|address|bytes(?:2|3|4|8|16|20|32)?|bool|string)\b/,
			/\b(abi\.encode|abi\.decode|keccak256|msg\.sender|msg\.value|onlyRole|require|revert|emit)\b/,
			/\b[A-Z][A-Za-z0-9_]*\s*\([^)]*(?:address|uint|bytes|bool|string)\b/,
		]
		if (strongSignals.some((pattern) => pattern.test(trimmed))) return true

		const codeLines = trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
		if (!codeLines.length || codeLines.length > 12) return false
		const assignmentLike = codeLines.filter((line) => /^[A-Za-z_][\w.]*\s*=\s*[\w.()+\-*/\s]+$/.test(line)).length
		return assignmentLike >= Math.max(1, Math.ceil(codeLines.length * 0.6))
	}

	const extractFunctionRefs = (source) => {
		const refs = []
		const lines = source.split("\n")
		let pendingComments = []
		let current = null
		const flush = () => {
			if (!current) return
			const signature = current.parts
				.join(" ")
				.replace(/\s+/g, " ")
				.replace(/\s*;\s*$/, "")
				.trim()
			if (!signature) {
				current = null
				return
			}
			const name = (signature.match(/\bfunction\s+([A-Za-z_][\w]*)/) || signature.match(/^([A-Za-z][\w.]*)\s*\(/) || [])[1]
			if (!name) {
				current = null
				return
			}
			const access = (signature.match(/\b(external|public|internal|private)\b/) || [])[1] || ""
			const modifiers = Array.from(signature.matchAll(/\b(view|pure|payable|onlyRole\([^)]+\))\b/g)).map((match) => match[1])
			const returns = (signature.match(/\breturns\s*\(([^)]*)\)/) || [])[1] || ""
			const comment = current.comment.join(" ").replace(/\s+/g, " ").trim()
			const role = (signature.match(/onlyRole\(([^)]+)\)/) || [])[1] || (/\bROLE\b|Setter only|Anyone|Diamond owner only|owner-only/i.test(comment) ? comment : "")
			refs.push({
				name,
				signature,
				access,
				modifiers: modifiers.filter((item) => !item.startsWith("onlyRole")),
				returns,
				role,
				description: role === comment ? "" : comment,
			})
			current = null
		}

		lines.forEach((line) => {
			const trimmed = line.trim()
			if (!trimmed) return
			if (trimmed.startsWith("//")) {
				pendingComments.push(trimmed.replace(/^\/\/\s*/, ""))
				return
			}
			if (/^(mapping|struct|enum|event|error|contract|interface|library|pragma|import)\b/.test(trimmed)) {
				pendingComments = []
				return
			}

			const commentSplit = trimmed.split(/\s+\/\/\s*/)
			const codePart = commentSplit.shift().trim()
			const inlineComment = commentSplit.join(" // ").trim()
			const startsSignature = /\bfunction\s+[A-Za-z_][\w]*\s*\(/.test(codePart) || /^[A-Za-z][\w.]*\s*\([^)]*\)/.test(codePart)
			if (!current && !startsSignature) {
				pendingComments = []
				return
			}
			if (!current) {
				current = { parts: [], comment: pendingComments.slice() }
				pendingComments = []
			}
			if (inlineComment) current.comment.push(inlineComment)
			current.parts.push(codePart)
			if (/[;{]\s*$/.test(codePart) || (!/\bfunction\b/.test(codePart) && /^[A-Za-z][\w.]*\s*\([^)]*\)\s*(?:returns\s*\([^)]*\))?$/.test(codePart))) flush()
		})
		flush()
		return refs
	}

	const installFunctionReference = (frame, source) => {
		const functions = extractFunctionRefs(source)
		if (functions.length < 2) return
		const details = document.createElement("details")
		details.className = "function-reference"
		details.innerHTML = `
			<summary><span>Function reference</span><small>${functions.length} signature${functions.length === 1 ? "" : "s"}</small></summary>
			<div class="function-grid">
				${functions
					.map(
						(item) => `
							<article class="function-card">
								<strong>${escapeHtml(item.name)}</strong>
								<code>${escapeHtml(item.signature)}</code>
								${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
								<div class="function-meta">
									${item.access ? `<span>${escapeHtml(item.access)}</span>` : ""}
									${item.modifiers.map((modifier) => `<span>${escapeHtml(modifier)}</span>`).join("")}
									${item.role ? `<span>${escapeHtml(item.role)}</span>` : ""}
									${item.returns ? `<span>returns ${escapeHtml(item.returns)}</span>` : ""}
								</div>
							</article>
						`
					)
					.join("")}
			</div>
		`
		frame.after(details)
	}

	document.querySelectorAll(".doc-article pre > code").forEach((code) => {
		if (code.classList.contains("language-mermaid")) return
		const hasLanguage = Array.from(code.classList).some((item) => item.startsWith("language-"))
		const source = code.textContent || ""
		if (code.classList.contains("language-solidity") || (!hasLanguage && looksLikeSolidity(source))) {
			code.classList.add("language-solidity")
			code.dataset.detectedLanguage = "solidity"
			code.innerHTML = highlightSolidity(source)
		}
	})

	document.querySelectorAll(".doc-article pre").forEach((pre) => {
		if (pre.closest(".mermaid-frame")) return
		if (pre.closest(".code-frame")) return
		const code = pre.querySelector("code")
		const frame = document.createElement("div")
		frame.className = "code-frame"
		if (code && code.classList.contains("language-solidity")) frame.classList.add("code-frame-solidity")
		const toolbar = document.createElement("div")
		toolbar.className = "code-toolbar"
		const actions = document.createElement("div")
		actions.className = "code-actions"
		const wrap = document.createElement("button")
		wrap.type = "button"
		setIconLabel(wrap, icons.wrap, "Wrap")
		wrap.addEventListener("click", () => {
			frame.classList.toggle("is-wrapped")
			setIconLabel(wrap, icons.wrap, frame.classList.contains("is-wrapped") ? "Unwrap" : "Wrap")
		})
		const copy = document.createElement("button")
		copy.type = "button"
		setIconLabel(copy, icons.copy, "Copy")
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(pre.textContent || "")
				setIconLabel(copy, icons.check, "Copied")
				window.setTimeout(() => {
					setIconLabel(copy, icons.copy, "Copy")
				}, 1200)
			} catch (_error) {
				const selection = window.getSelection()
				if (selection) {
					const range = document.createRange()
					range.selectNodeContents(pre)
					selection.removeAllRanges()
					selection.addRange(range)
				}
				setIconLabel(copy, icons.check, selection ? "Selected" : "Copy unavailable")
				window.setTimeout(() => {
					setIconLabel(copy, icons.copy, "Copy")
				}, 1200)
			}
		})
		actions.append(wrap, copy)
		toolbar.append(actions)
		pre.before(frame)
		frame.append(toolbar, pre)
		if (code && code.classList.contains("language-solidity") && !pre.closest("[data-disable-function-reference]")) {
			installFunctionReference(frame, code.textContent || "")
		}
	})

	const installHeadingLinks = () => {
		document.querySelectorAll(".doc-article h2[id], .doc-article h3[id]").forEach((heading) => {
			if (heading.querySelector(".heading-anchor")) return
			const anchor = document.createElement("button")
			anchor.type = "button"
			anchor.className = "heading-anchor"
			anchor.textContent = "#"
			anchor.setAttribute("aria-label", `Copy link to ${heading.textContent || "section"}`)
			const defaultLabel = anchor.getAttribute("aria-label")
			anchor.addEventListener("click", async () => {
				const url = `${window.location.href.split("#")[0]}#${heading.id}`
				try {
					await navigator.clipboard.writeText(url)
					anchor.textContent = "✓"
					anchor.setAttribute("aria-label", "Section link copied")
					window.setTimeout(() => {
						anchor.textContent = "#"
						anchor.setAttribute("aria-label", defaultLabel)
					}, 1100)
				} catch (_error) {
					window.location.hash = heading.id
				}
			})
			heading.append(anchor)
		})
	}

	installHeadingLinks()

	const tocLinks = Array.from(document.querySelectorAll(".toc-link"))
	if (tocLinks.length) {
		const tocScroller =
			document.querySelector(".side-toc .arc-section-list") ||
			document.querySelector(".side-toc .toc-card") ||
			document.querySelector(".toc-panel")
		const byId = new Map()
		tocLinks.forEach((link) => {
			let id = ""
			try {
				id = decodeURIComponent((link.getAttribute("href") || "").replace(/^#/, ""))
			} catch (_error) {
				id = ""
			}
			if (id) byId.set(id, link)
			link.addEventListener("click", (event) => {
				const heading = id ? document.getElementById(id) : null
				if (!heading) return
				event.preventDefault()
				holdClickedSection(id)
				if (id) setActiveToc(id, { scroll: false })
				window.history.pushState(null, "", `#${encodeURIComponent(id)}`)
				scrollToHeading(heading)
			})
		})
		const headings = Array.from(document.querySelectorAll(".doc-article h2[id], .doc-article h3[id]")).filter((heading) => byId.has(heading.id))
		let activeId = ""
		let ticking = false
		let lockedActiveId = ""
		let unlockTimer = 0
		function setActiveToc(id, options = {}) {
			const active = byId.get(id)
			if (!active || activeId === id) return
			if (activeId && byId.has(activeId)) {
				const previous = byId.get(activeId)
				previous.classList.remove("is-active")
				previous.removeAttribute("aria-current")
			}
			activeId = id
			active.classList.add("is-active")
			active.setAttribute("aria-current", "location")
			if (options.scroll !== false && tocScroller && tocScroller.scrollHeight > tocScroller.clientHeight) {
				const panelRect = tocScroller.getBoundingClientRect()
				const activeRect = active.getBoundingClientRect()
				if (activeRect.top < panelRect.top + 12) {
					tocScroller.scrollTop = Math.max(0, tocScroller.scrollTop + activeRect.top - panelRect.top - 18)
				} else if (activeRect.bottom > panelRect.bottom - 12) {
					tocScroller.scrollTop = tocScroller.scrollTop + activeRect.bottom - panelRect.bottom + 18
				}
			}
		}
		function activeFromScroll() {
			ticking = false
			if (!headings.length) return
			if (lockedActiveId && byId.has(lockedActiveId)) {
				setActiveToc(lockedActiveId)
				return
			}
			const marker = getAnchorOffset() + 2
			let current = headings[0]
			for (const heading of headings) {
				if (heading.getBoundingClientRect().top <= marker) current = heading
				else break
			}
			setActiveToc(current.id)
		}
		function getAnchorOffset() {
			const header = document.querySelector(".doc-topbar")
			const headerBottom = header ? header.getBoundingClientRect().bottom : 0
			return Math.max(28, Math.ceil(headerBottom + 20))
		}
		function scrollToHeading(heading) {
			const targetTop = heading.getBoundingClientRect().top + window.scrollY - getAnchorOffset()
			window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" })
		}
		function requestActiveFromScroll() {
			if (ticking) return
			ticking = true
			window.requestAnimationFrame(activeFromScroll)
		}
		function holdClickedSection(id) {
			lockedActiveId = id
			window.clearTimeout(unlockTimer)
			unlockTimer = window.setTimeout(unlockClickedSection, 1200)
		}
		function unlockClickedSection() {
			if (!lockedActiveId) return
			window.clearTimeout(unlockTimer)
			lockedActiveId = ""
			requestActiveFromScroll()
		}
		function activeFromHash() {
			let id = ""
			try {
				id = decodeURIComponent(window.location.hash.replace(/^#/, ""))
			} catch (_error) {
				id = ""
			}
			if (id && byId.has(id)) setActiveToc(id)
			else activeFromScroll()
		}
		window.addEventListener("scroll", requestActiveFromScroll, { passive: true })
		window.addEventListener("resize", requestActiveFromScroll)
		window.addEventListener("hashchange", activeFromHash)
		window.addEventListener("scrollend", unlockClickedSection, { passive: true })
		window.addEventListener("wheel", unlockClickedSection, { passive: true })
		window.addEventListener("touchstart", unlockClickedSection, { passive: true })
		window.addEventListener("keydown", (event) => {
			if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp", " "].includes(event.key)) {
				unlockClickedSection()
			}
		})
		activeFromHash()
		window.setTimeout(activeFromHash, 80)
	}
})()
