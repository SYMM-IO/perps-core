(() => {
	const body = document.body;
	if (!body) return;

	const normalize = value => value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
	const escapeHtml = value =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	const pad2 = value => String(value).padStart(2, "0");
	const store = {
		get(key) {
			try {
				return window.localStorage ? localStorage.getItem(key) : null;
			} catch (_error) {
				return null;
			}
		},
		set(key, value) {
			try {
				if (window.localStorage) localStorage.setItem(key, value);
			} catch (_error) {
				// File URLs and embedded browsers can deny storage; controls still work for this page load.
			}
		},
	};

	const icons = {
		rail: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>',
		close: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
		up: '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
	};

	/* --- Chapter manifest ----------------------------------------------------
	   One ordered list per release. It drives the chapter rail, the
	   "Chapter NN of NN" kicker, and the previous/next pager, so those three
	   never disagree. Every chapter is its own `<slug>.html` reader page.

	   Titles here must match the chapter page's own <h1> and its catalog card
	   verbatim: one chapter, one name, on every surface. `npm run docs:check`
	   fails the build when they drift. */
	const MANIFESTS = {
		"0.8.5": [
			["account-layer", "Account & Fund Management", "AccountLayer"],
			["withdraw-system", "Account & Fund Management", "New Withdraw System"],
			["virtual-funds", "Account & Fund Management", "Virtual Fund System"],
			["external-transfer", "Account & Fund Management", "External Transfer"],
			["express-deposit", "Account & Fund Management", "Express Deposit & Withdrawal System"],
			["safe-deallocate", "Account & Fund Management", "SafeDeallocate"],
			["cross-party-b", "Trading Execution", "Cross Mode for Solvers"],
			["oracle-less-trading", "Trading Execution", "Oracle-Less Trading"],
			["batch-positions", "Trading Execution", "Batch Position Management"],
			["instant-layer-overview", "Trading Execution", "Better Instant actions through Instant Layer"],
			["instant-layer-partyb-integration", "Trading Execution", "InstantLayer PartyB Integration Guide"],
			["instant-layer-service-integration", "Trading Execution", "Instant Layer Service Integration Guide"],
			["clearing-house", "Risk & Liquidation", "ClearingHouse"],
			["soft-liquidation", "Risk & Liquidation", "Soft Liquidation"],
			["adl-close", "Risk & Liquidation", "ADL Close (Auto-Deleveraging)"],
			["pledge", "Risk & Liquidation", "Pledge Collateral"],
			["cross-mode-liquidation-settlement", "Risk & Liquidation", "Cross-Mode Settlement During Liquidation"],
			["liquidation-insurance", "Risk & Liquidation", "Liquidation Insurance Vault"],
			["liquidation-escrow", "Risk & Liquidation", "Liquidation Escrow"],
			["accumulated-funding", "Funding & Positions", "Accumulated Funding Rate"],
			["aggregated-positions", "Funding & Positions", "Aggregated Positions And Fundings For Better UPNL Calculation"],
			["affiliate-fees", "Fees & Symbols", "Custom open/close fee for affiliates"],
			["symbol-types", "Fees & Symbols", "Symbol Types"],
			["custom-quote-data", "Fees & Symbols", "Storing custom data in quotes"],
			["muon-keys", "Infrastructure", "Muon Signature Verification and Key Management"],
			["hook-system", "Infrastructure", "Hook System"],
			["va-lifecycle-hooks", "Infrastructure", "Virtual Account Lifecycle Hooks"],
			["role-admin-system", "Infrastructure", "Role Admin System"],
			["two-step-ownership", "Infrastructure", "Two-Step Ownership Transfer"],
			["event-changelog", "Infrastructure", "Event Changelog: v0.8.4 to v0.8.5"],
			["migration", "Upgrade & Migration", "Migration Process"],
			["setup-task", "Upgrade & Migration", "System Deployment Guide"],
		],
		"0.8.6": [
			["express-withdrawal-system-design", "Express Withdrawal", "Express Withdrawal System Design"],
			["account-layer-ownership-delegation", "AccountLayer", "AccountLayer Delegated Creation & Ownership Transfer"],
			["liquidation-funding-snapshot-fix", "Liquidation", "PartyA Liquidation Snapshot Flow"],
			["single-step-partya-liquidation", "Liquidation", "Single-Step PartyA Liquidation"],
			["affiliate-shutdown-flow", "Clearing House", "Affiliate Shutdown Flow"],
			["muon-upnl-validity-overrides", "Muon", "Muon UPNL Validity Overrides"],
			["solver-fees", "Fees", "Solver Fees"],
			["operational-fees", "Fees", "Operational Fees"],
			["balance-change-event-cleanup", "Events & Indexing", "Allocated Balance Event Ledger"],
			["symbol-adjustment", "Symbols", "Symbol Corporate-Action Adjustment"],
			["strict-deallocation", "Accounts", "Strict Deallocation"],
			["instant-open-gas-optimization", "Performance", "InstantOpen Gas Optimization"],
			["partya-liquidation-fee-recipient", "Liquidation", "PartyA Liquidation Fee Recipient Cleanup"],
			["partyb-allocation-suspension-gates", "PartyB", "PartyB Allocation Suspension Gates"],
			["cross-partyb-liquidation-reserve", "Liquidation", "Cross-PartyB Liquidation Reserve Enforcement"],
			["delegation-account-scope", "AccountLayer", "Delegation Account Scope"],
			["instant-layer-authorization-scope", "InstantLayer", "InstantLayer Authorization Scope"],
			["market-open-fee-execution-price", "Fees", "Market Open Fee on Execution Price"],
			["partyb-funding-nonces", "PartyB", "PartyB Funding Update Nonces"],
			["bound-mode-unified-settlement", "Settlement", "Bound-Mode Unified Settlement"],
			["diamond-owner-getter", "Views", "Diamond Owner Getter"],
			["express-deposit-removal", "AccountLayer", "Express Deposit Removal"],
			["accountlayer-behavior-changes", "AccountLayer", "AccountLayer Behavior Changes"],
			["lazy-accumulated-funding", "Funding", "Lazy Accumulated Funding"],
		],
	};

	/* Pages that ship inside a release but sit outside the numbered changelog.
	   They get the same shell and rail, but no chapter number and no pager. */
	const COMPANIONS = {
		"0.8.6": {
			"express-bot-operations-checklist": ["Express Withdrawal", "Bot Operations Checklist"],
		},
	};

	const version = body.dataset.version || "";
	const manifest = (MANIFESTS[version] || []).map(([slug, category, title], index) => ({
		slug,
		category,
		title,
		number: index + 1,
	}));
	const companions = COMPANIONS[version] || {};
	const currentSlug = decodeURIComponent((location.pathname.split("/").pop() || "").replace(/\.html?$/i, ""));

	/* --- Rail ---------------------------------------------------------------
	   One navigation surface for every reading page. A single-panel rail uses a
	   plain heading; multi-panel references retain accessible tabs. */
	const buildRail = ({ id, label, tabs, active }) => {
		const rail = document.createElement("aside");
		rail.className = "chapter-rail";
		rail.id = id;
		rail.setAttribute("aria-label", label);
		const singlePanel = tabs.length === 1;
		if (singlePanel) rail.classList.add("is-single-panel");

		const tabRow = singlePanel
			? `<p class="rail-title" id="${id}-title">${escapeHtml(tabs[0].label)}</p>`
			: tabs
					.map(
						tab =>
							`<button type="button" class="rail-tab" role="tab" id="${id}-tab-${tab.key}" aria-controls="${id}-panel-${tab.key}"` +
							` aria-selected="false" data-rail-tab="${tab.key}">${escapeHtml(tab.label)}</button>`,
					)
					.join("");
		const panelRow = tabs
			.map(
				tab =>
					`<div class="rail-panel" role="${singlePanel ? "region" : "tabpanel"}" id="${id}-panel-${tab.key}"` +
					` aria-labelledby="${singlePanel ? `${id}-title` : `${id}-tab-${tab.key}`}" data-rail-panel="${tab.key}"${singlePanel ? "" : " hidden"}>` +
					(tab.search
						? `<label class="visually-hidden" for="${id}-search-${tab.key}">${escapeHtml(tab.search)}</label>` +
							`<input class="rail-search" id="${id}-search-${tab.key}" type="search" placeholder="${escapeHtml(tab.search)}"` +
							` autocomplete="off" data-rail-search="${tab.key}" />`
						: "") +
					`<div class="rail-list" data-rail-list="${tab.key}"></div>` +
					"</div>",
			)
			.join("");

		rail.innerHTML =
			'<div class="rail-inner">' +
			`<div class="rail-tabs"${singlePanel ? "" : ` role="tablist" aria-label="${escapeHtml(label)}"`}>${tabRow}` +
			'<button type="button" class="rail-collapse" data-rail-collapse aria-controls="' +
			id +
			'" aria-label="Hide navigation" title="Hide navigation">' +
			icons.rail +
			"</button>" +
			"</div>" +
			panelRow +
			"</div>";

		const tabButtons = Array.from(rail.querySelectorAll("[data-rail-tab]"));
		const panels = Array.from(rail.querySelectorAll("[data-rail-panel]"));
		const setTab = key => {
			if (singlePanel) {
				panels[0].hidden = false;
				return;
			}
			tabButtons.forEach(button => button.setAttribute("aria-selected", String(button.dataset.railTab === key)));
			panels.forEach(panel => {
				panel.hidden = panel.dataset.railPanel !== key;
			});
			store.set("docs-rail-tab", key);
		};
		tabButtons.forEach(button => {
			button.addEventListener("click", () => setTab(button.dataset.railTab));
		});
		tabButtons.forEach((button, index) => {
			button.addEventListener("keydown", event => {
				const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
				if (!step) return;
				event.preventDefault();
				const next = tabButtons[(index + step + tabButtons.length) % tabButtons.length];
				next.focus();
				setTab(next.dataset.railTab);
			});
		});

		const stored = singlePanel ? null : store.get("docs-rail-tab");
		setTab(!singlePanel && tabs.some(tab => tab.key === stored) ? stored : active || tabs[0].key);

		return {
			rail,
			setTab,
			list: key => rail.querySelector(`[data-rail-list="${key}"]`),
			search: key => rail.querySelector(`[data-rail-search="${key}"]`),
		};
	};

	/* Search inside a rail panel. Groups vanish only when every link in them is
	   filtered out, and an explicit empty state replaces a silent blank panel. */
	const wireRailSearch = (input, listHost) => {
		if (!input) return;
		const empty = document.createElement("p");
		empty.className = "rail-empty";
		empty.textContent = "No chapters match that search.";
		empty.hidden = true;
		listHost.append(empty);
		input.addEventListener("input", () => {
			const query = normalize(input.value);
			const links = Array.from(listHost.querySelectorAll(".rail-link"));
			let shown = 0;
			links.forEach(link => {
				// The rail groups by category, so a category name has to be searchable
				// even when it is not repeated in the chapter title.
				const group = link.closest(".rail-group");
				const haystack = normalize(`${link.textContent || ""} ${group?.querySelector(".rail-group-title")?.textContent || ""}`);
				const match = !query || haystack.includes(query);
				link.hidden = !match;
				if (match) shown += 1;
			});
			listHost.querySelectorAll(".rail-group").forEach(group => {
				group.hidden = !Array.from(group.querySelectorAll(".rail-link")).some(link => !link.hidden);
			});
			empty.hidden = shown !== 0;
		});
	};

	/* Grouped, numbered chapter links. `hrefFor` decides whether the rail points
	   at sibling pages or at anchors inside one long document. */
	const renderChapterList = (listHost, entries, hrefFor, isCurrent) => {
		const groups = new Map();
		entries.forEach(entry => {
			let group = groups.get(entry.category);
			if (!group) {
				group = document.createElement("section");
				group.className = "rail-group";
				group.innerHTML = `<h2 class="rail-group-title">${escapeHtml(entry.category)}</h2>`;
				groups.set(entry.category, group);
				listHost.append(group);
			}
			const link = document.createElement("a");
			link.className = "rail-link";
			link.href = hrefFor(entry);
			link.innerHTML = `<span class="rail-index">${pad2(entry.number)}</span><span class="rail-label">${escapeHtml(entry.title)}</span>`;
			if (isCurrent && isCurrent(entry)) {
				link.classList.add("is-active");
				link.setAttribute("aria-current", "page");
			}
			group.append(link);
		});
	};

	/* Compact drawer + desktop collapse, shared by every rail. */
	const wireRailChrome = (rail, { trigger }) => {
		const compact = window.matchMedia("(max-width: 980px)");
		const collapse = rail.querySelector("[data-rail-collapse]");
		const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";
		const backdrop = document.createElement("button");
		backdrop.type = "button";
		backdrop.className = "rail-backdrop";
		backdrop.setAttribute("aria-label", "Close navigation");
		body.append(backdrop);

		let returnFocus = null;
		let lockedScrollY = 0;
		const setOpen = (open, restoreAfterLayout = false) => {
			const shouldOpen = compact.matches && open;
			const wasOpen = body.classList.contains("rail-is-open");
			if (shouldOpen && !wasOpen) {
				lockedScrollY = window.scrollY;
				body.style.top = `-${lockedScrollY}px`;
			}
			body.classList.toggle("rail-is-open", shouldOpen);
			if (!shouldOpen && wasOpen) {
				const restoreScrollY = lockedScrollY;
				body.style.removeProperty("top");
				window.scrollTo(0, restoreScrollY);
				if (restoreAfterLayout) window.requestAnimationFrame(() => window.scrollTo(0, restoreScrollY));
			}
			rail.toggleAttribute("inert", compact.matches && !shouldOpen);
			if (trigger) trigger.setAttribute("aria-expanded", String(shouldOpen));
			describeCollapse();
			if (shouldOpen) {
				returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
				window.requestAnimationFrame(() => {
					const first = rail.querySelector("[data-rail-collapse], [data-rail-tab], .toc-link, .rail-link");
					if (first) first.focus();
				});
			} else if (returnFocus && document.contains(returnFocus)) {
				returnFocus.focus({ preventScroll: true });
				returnFocus = null;
			}
		};

		// The same control closes the drawer at compact widths and collapses the
		// rail on wide screens, so the rail only ever needs one dismiss affordance.
		const describeCollapse = () => {
			if (!collapse) return;
			const drawer = compact.matches;
			const collapsed = body.classList.contains("rail-is-collapsed");
			const label = drawer ? "Close navigation" : collapsed ? "Show navigation" : "Hide navigation";
			collapse.innerHTML = drawer ? icons.close : icons.rail;
			collapse.setAttribute("aria-label", label);
			collapse.setAttribute("title", label);
			collapse.setAttribute("aria-expanded", String(drawer ? body.classList.contains("rail-is-open") : !collapsed));
		};

		const setCollapsed = (collapsed, persist = true) => {
			if (compact.matches) {
				describeCollapse();
				return;
			}
			body.classList.toggle("rail-is-collapsed", collapsed);
			describeCollapse();
			if (persist) store.set("docs-rail-collapsed", String(collapsed));
		};

		if (trigger) {
			trigger.addEventListener("click", () => {
				const closing = body.classList.contains("rail-is-open");
				setOpen(!closing, closing);
			});
		}
		if (collapse) {
			collapse.addEventListener("click", () => {
				if (compact.matches) setOpen(false, true);
				else setCollapsed(!body.classList.contains("rail-is-collapsed"));
			});
		}
		backdrop.addEventListener("click", () => setOpen(false, true));
		rail.addEventListener("click", event => {
			if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
		});
		window.addEventListener("keydown", event => {
			if (!body.classList.contains("rail-is-open")) return;
			if (event.key === "Escape") {
				setOpen(false, true);
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = Array.from(rail.querySelectorAll(focusableSelector)).filter(
				element => element instanceof HTMLElement && element.getClientRects().length > 0,
			);
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (!rail.contains(document.activeElement)) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
			} else if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		});
		compact.addEventListener("change", () => {
			setOpen(false, true);
			if (compact.matches) body.classList.remove("rail-is-collapsed");
			else setCollapsed(store.get("docs-rail-collapsed") === "true", false);
		});
		setOpen(false);
		setCollapsed(store.get("docs-rail-collapsed") === "true", false);
	};

	/* The compact-width rail trigger, added to whatever top bar the page has. */
	const installRailTrigger = (railId, label) => {
		const actions = document.querySelector(".docs-header .top-actions");
		if (!actions) return null;
		const trigger = document.createElement("button");
		trigger.type = "button";
		trigger.className = "button ghost rail-trigger";
		trigger.dataset.railTrigger = "true";
		trigger.setAttribute("aria-controls", railId);
		trigger.setAttribute("aria-expanded", "false");
		trigger.innerHTML = `${icons.rail}<span>${escapeHtml(label)}</span>`;
		actions.prepend(trigger);
		return trigger;
	};

	/* A breadcrumb reads ancestor to current. The release crumb stays a link to the
	   catalog it names, and the page the reader is actually on becomes the final,
	   non-link crumb — previously the trail ended in a link pointing back up and
	   never named the current page at all. */
	const installTrailCurrent = title => {
		const trail = document.querySelector(".docs-header .docs-trail");
		if (!trail || !title || trail.querySelector("[data-trail-current]")) return;
		const separator = document.createElement("span");
		separator.className = "trail-sep";
		separator.setAttribute("aria-hidden", "true");
		separator.textContent = "/";
		const current = document.createElement("span");
		current.className = "trail-current trail-chapter";
		current.dataset.trailCurrent = "true";
		current.setAttribute("aria-current", "page");
		current.textContent = title;
		trail.append(separator, current);
	};

	/* Tracks which heading the reader is inside and mirrors it in the rail. */
	const trackSections = (listHost, headings) => {
		if (!headings.length) return;
		const links = new Map();
		listHost.querySelectorAll(".toc-link").forEach(link => {
			let id = "";
			try {
				id = decodeURIComponent((link.getAttribute("href") || "").replace(/^#/, ""));
			} catch (_error) {
				id = "";
			}
			if (id) links.set(id, link);
		});
		if (!links.size) return;
		const trackedHeadings = headings.filter(heading => links.has(heading.id));
		if (!trackedHeadings.length) return;
		const scrollHost = listHost.closest(".rail-panel") || listHost;

		let activeId = "";
		let frame = 0;
		const apply = () => {
			frame = 0;
			const marker = headerHeight() + 24;
			const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
			const atDocumentEnd = window.scrollY + window.innerHeight >= documentHeight - 2;
			let current = atDocumentEnd ? trackedHeadings.at(-1) : trackedHeadings[0];
			if (!atDocumentEnd) {
				for (const heading of trackedHeadings) {
					if (heading.getBoundingClientRect().top <= marker) current = heading;
					else break;
				}
			}
			if (!current || current.id === activeId) return;
			const previous = links.get(activeId);
			if (previous) {
				previous.classList.remove("is-active");
				previous.removeAttribute("aria-current");
			}
			activeId = current.id;
			const link = links.get(activeId);
			if (!link) return;
			link.classList.add("is-active");
			link.setAttribute("aria-current", "location");
			if (scrollHost.scrollHeight > scrollHost.clientHeight) {
				const hostRect = scrollHost.getBoundingClientRect();
				const linkRect = link.getBoundingClientRect();
				if (linkRect.top < hostRect.top + 12) scrollHost.scrollTop += linkRect.top - hostRect.top - 18;
				else if (linkRect.bottom > hostRect.bottom - 12) scrollHost.scrollTop += linkRect.bottom - hostRect.bottom + 18;
			}
		};
		const schedule = () => {
			if (!frame) frame = window.requestAnimationFrame(apply);
		};
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		window.addEventListener("hashchange", schedule);
		apply();
	};

	/* Turns authored numbered headings into a quieter, reference-style contents
	   list without asking every page to duplicate presentation markup. Top-level
	   section numbers get their own gutter; consecutive subsections share one
	   visual spine. The original link text remains the accessible name. */
	const formatSectionMenu = listHost => {
		const links = Array.from(listHost.children).filter(child => child.classList?.contains("toc-link"));
		let subsectionGroup = null;
		let subsectionLabel = "Subsections";

		links.forEach(link => {
			if (link.classList.contains("level-2")) {
				subsectionGroup = null;
				subsectionLabel = `${(link.textContent || "Section").trim()} subsections`;
				const match = (link.textContent || "").trim().match(/^(\d+)\.\s+(.+)$/);
				if (!match) return;

				const index = document.createElement("span");
				index.className = "toc-section-index";
				index.setAttribute("aria-hidden", "true");
				index.textContent = match[1];
				const label = document.createElement("span");
				label.className = "toc-section-label";
				label.textContent = match[2];
				link.classList.add("has-section-index");
				link.setAttribute("aria-label", `${match[1]}. ${match[2]}`);
				link.replaceChildren(index, label);
				return;
			}

			if (!link.classList.contains("level-3")) return;
			if (!subsectionGroup) {
				subsectionGroup = document.createElement("div");
				subsectionGroup.className = "toc-sublist";
				subsectionGroup.setAttribute("role", "group");
				subsectionGroup.setAttribute("aria-label", subsectionLabel);
				link.before(subsectionGroup);
			}
			subsectionGroup.append(link);
		});
	};

	const headerHeight = () => {
		const header = document.querySelector(".docs-header");
		return header ? Math.ceil(header.getBoundingClientRect().height) : 0;
	};

	/* --- Chapter pages ------------------------------------------------------ */
	const installReaderShell = () => {
		if (!body.classList.contains("doc-page")) return;
		const shell = document.querySelector(".reader-shell");
		const main = document.querySelector(".reader-main");
		const hero = document.querySelector(".reader-hero");
		const article = document.querySelector(".doc-article");
		if (!shell || !main || !hero || !article) return;

		const authored = document.querySelector("[data-rail-sections]");
		const entry = manifest.find(item => item.slug === currentSlug);
		const companion = companions[currentSlug];

		// Two panels: where you are inside this chapter, and where every other
		// chapter is. Without the second one the only way to a sibling chapter is
		// the pager or a round trip through the catalog.
		const tabs = [{ key: "sections", label: "On this page" }];
		if (manifest.length) tabs.push({ key: "chapters", label: "Chapters", search: "Search chapters" });

		const { rail, list, search } = buildRail({
			id: "docs-rail",
			label: "Documentation navigation",
			tabs,
			active: "sections",
		});

		const sectionList = list("sections");
		if (authored) {
			Array.from(authored.children).forEach(child => sectionList.append(child));
			authored.remove();
		}
		formatSectionMenu(sectionList);
		if (!sectionList.querySelector(".toc-link")) {
			const empty = document.createElement("p");
			empty.className = "rail-empty";
			empty.textContent = "This chapter has no subsections.";
			sectionList.append(empty);
		}

		if (manifest.length) {
			const chapterList = list("chapters");
			renderChapterList(
				chapterList,
				manifest,
				item => `${item.slug}.html`,
				item => item.slug === currentSlug,
			);
			wireRailSearch(search("chapters"), chapterList);
		}

		shell.prepend(rail);
		installTrailCurrent(entry?.title || companion?.[1] || (document.querySelector(".reader-hero h1")?.textContent || "").trim());
		wireRailChrome(rail, { trigger: installRailTrigger(rail.id, "Contents") });

		// One kicker replaces the old breadcrumb, whose last crumb named the
		// category rather than the page the reader was on. A page that authors
		// its own kicker keeps it.
		if (!hero.querySelector(".topic-kicker")) {
			const kicker = document.createElement("p");
			kicker.className = "topic-kicker";
			if (entry) {
				kicker.innerHTML = `<span>${escapeHtml(entry.category)}</span><span>Chapter ${pad2(entry.number)} of ${pad2(manifest.length)}</span>`;
			} else if (companion) {
				kicker.innerHTML = `<span>${escapeHtml(companion[0])}</span><span>Companion guide</span>`;
			} else {
				kicker.innerHTML = "<span>Reference</span>";
			}
			hero.prepend(kicker);
		}

		if (entry) {
			const previous = manifest[entry.number - 2];
			const next = manifest[entry.number];
			if (previous || next) {
				const pager = document.createElement("nav");
				pager.className = "chapter-pager";
				pager.setAttribute("aria-label", "Adjacent chapters");
				if (previous)
					pager.innerHTML += `<a href="${previous.slug}.html"><small>Previous</small><span>${escapeHtml(previous.title)}</span></a>`;
				if (next) pager.innerHTML += `<a href="${next.slug}.html"><small>Next</small><span>${escapeHtml(next.title)}</span></a>`;
				main.append(pager);
			}
		}

		trackSections(sectionList, Array.from(article.querySelectorAll("h2[id], h3[id], h4[id]")));
	};

	/* Both search fields answer to the same keys, so the shortcut a reader learns on
	   the portal still works on the release catalog. */
	const wireSearchShortcuts = (input, apply) => {
		window.addEventListener("keydown", event => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				input.focus();
				input.select();
			} else if (event.key === "Escape" && document.activeElement === input && input.value) {
				input.value = "";
				apply();
			}
		});
	};

	/* The hint reflects the platform's own modifier rather than always showing ⌘. */
	const labelSearchShortcut = () => {
		const isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
		document.querySelectorAll("[data-search-hint]").forEach(hint => {
			hint.textContent = isApple ? "⌘K" : "Ctrl K";
		});
	};

	/* --- Release catalogs --------------------------------------------------- */
	const installCatalog = () => {
		const input = document.querySelector("[data-catalog-search]");
		if (!input) return;
		// Items carry `data-catalog-item` where the markup was updated for it, and
		// fall back to the two catalog row shapes so a release index that predates
		// the attribute still filters instead of hiding everything.
		const items = Array.from(document.querySelectorAll("[data-catalog-item]"));
		const rows = items.length ? items : Array.from(document.querySelectorAll(".doc-list-item, .minor-improvement-item"));
		if (!rows.length) return;
		const groups = Array.from(document.querySelectorAll("[data-catalog-group]"));
		const count = document.querySelector("[data-catalog-count]");
		const empty = document.querySelector("[data-catalog-empty]");
		const groupCounts = new Map(groups.map(group => [group, group.querySelector("[data-catalog-group-count]")]));
		const total = rows.length;

		const describe = value => {
			const unit = count?.dataset.catalogUnit || "chapter";
			return `${value} ${value === 1 ? unit : `${unit}s`}`;
		};

		const apply = () => {
			const query = normalize(input.value);
			let shown = 0;
			rows.forEach(row => {
				const match = !query || normalize(row.textContent || "").includes(query);
				row.hidden = !match;
				if (match) shown += 1;
			});
			groups.forEach(group => {
				const groupRows = rows.filter(row => group.contains(row));
				const visible = groupRows.filter(row => !row.hidden).length;
				group.hidden = groupRows.length > 0 && visible === 0;
				const label = groupCounts.get(group);
				if (label) label.textContent = describe(visible);
			});
			if (count) count.textContent = query ? `${describe(shown)} of ${total}` : describe(total);
			if (empty) empty.hidden = shown !== 0;
		};

		groups.forEach(group => {
			const label = groupCounts.get(group);
			if (label) label.textContent = describe(rows.filter(row => group.contains(row)).length);
		});
		if (count) count.textContent = describe(total);
		input.addEventListener("input", apply);
		wireSearchShortcuts(input, apply);
	};

	/* --- Version portal search --------------------------------------------- */
	// A search field, a live count and a keyboard shortcut are worth their space
	// only once the list is long enough to be worth filtering. Below that the
	// controls stay in the markup but out of the way.
	const VERSION_SEARCH_MIN_ITEMS = 6;

	const installVersionSearch = () => {
		const input = document.querySelector("[data-version-search]");
		if (!input) return;
		const items = Array.from(document.querySelectorAll("[data-version-item]"));
		if (!items.length) return;
		if (items.length < VERSION_SEARCH_MIN_ITEMS) {
			input.closest(".portal-search")?.remove();
			document.querySelector("[data-version-count]")?.remove();
			return;
		}
		const count = document.querySelector("[data-version-count]");
		const empty = document.querySelector("[data-version-empty]");
		const describe = value => `${value} ${value === 1 ? "version" : "versions"}`;

		const apply = () => {
			const query = normalize(input.value);
			let shown = 0;
			items.forEach(item => {
				const searchableText = `${item.textContent || ""} ${item.getAttribute("aria-label") || ""}`;
				const match = !query || normalize(searchableText).includes(query);
				item.hidden = !match;
				if (match) shown += 1;
			});
			if (count) count.textContent = query ? `${describe(shown)} of ${items.length}` : describe(items.length);
			if (empty) empty.hidden = shown !== 0;
		};

		input.addEventListener("input", apply);
		wireSearchShortcuts(input, apply);
	};

	/* --- Back to top -------------------------------------------------------- */
	const installBackToTop = () => {
		let button = document.querySelector("[data-back-to-top]");
		if (!button && body.classList.contains("doc-page")) {
			button = document.createElement("button");
			button.type = "button";
			button.className = "back-to-top";
			button.dataset.backToTop = "true";
			button.setAttribute("aria-label", "Back to top");
			button.innerHTML = icons.up;
			body.append(button);
		}
		if (!button) return;
		if (!button.querySelector("svg")) button.innerHTML = icons.up;
		const sync = () => button.classList.toggle("is-visible", window.scrollY > 900);
		window.addEventListener("scroll", sync, { passive: true });
		button.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
		sync();
	};

	/* --- Deep links --------------------------------------------------------- */
	// Diagrams and code frames land after first paint, so a hash target moves.
	// Re-align it a few times instead of leaving the reader mid-chapter.
	const initialHash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
	const alignInitialHash = () => {
		if (!initialHash) return;
		const target = document.getElementById(initialHash);
		if (!target) return;
		const root = document.documentElement;
		const previousBehavior = root.style.scrollBehavior;
		root.style.scrollBehavior = "auto";
		target.scrollIntoView({ block: "start" });
		root.style.scrollBehavior = previousBehavior;
	};

	installReaderShell();
	installCatalog();
	installVersionSearch();
	labelSearchShortcut();
	installBackToTop();

	// Reader pages can need delayed realignment as diagrams settle into place.
	if (initialHash) {
		window.addEventListener(
			"load",
			() => {
				alignInitialHash();
				[300, 1200, 2400].forEach(delay => window.setTimeout(alignInitialHash, delay));
			},
			{ once: true },
		);
	}
})();
