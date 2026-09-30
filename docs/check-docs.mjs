#!/usr/bin/env node
/**
 * Consistency check for the static docs site.
 *
 * The chapter list is necessarily written out in more than one place: the files
 * under `<release>/pages/`, the catalog markup in `<release>/index.html`, the
 * `MANIFESTS` table in `assets/docs-portal.js`, and the legacy-URL slug array in
 * `v0.8.5/complete.html`. Nothing at runtime reconciles them, so they drift
 * quietly — this asserts they agree.
 *
 * Run: node docs/check-docs.mjs   (or `npm run docs:check`)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = dirname(fileURLToPath(import.meta.url));
const problems = [];
const fail = (where, message) => problems.push({ where, message });

const read = path => readFileSync(join(DOCS, path), "utf8");
const stripTags = value =>
	value
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&ldquo;|&rdquo;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
const decodeHtmlEntities = value =>
	value
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
		.replace(/&(amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]);

const htmlFiles = (function walk(dir) {
	return readdirSync(join(DOCS, dir), { withFileTypes: true }).flatMap(item => {
		const next = dir ? `${dir}/${item.name}` : item.name;
		if (item.isDirectory()) return walk(next);
		return item.name.endsWith(".html") ? [next] : [];
	});
})("");

/* --- 1. The manifest, the catalog, and the page files describe one list ---- */

const portal = read("assets/docs-portal.js");
const portalCss = read("assets/docs-portal.css");
if (!/\[data-catalog-item\]\[hidden\][^{]*\{[^}]*display:\s*none/.test(portalCss)) {
	fail("assets/docs-portal.css", "hidden catalog search results must use display: none");
}
const manifestFor = version => {
	const block = new RegExp(`"${version}":\\s*\\[([\\s\\S]*?)\\n\\t\\t\\],`).exec(portal);
	if (!block) return null;
	return [...block[1].matchAll(/\["([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\]/g)].map(m => ({
		slug: m[1],
		category: m[2],
		title: m[3],
	}));
};

const releases = readdirSync(DOCS, { withFileTypes: true })
	.filter(item => item.isDirectory() && /^v\d+\.\d+\.\d+$/.test(item.name))
	.map(item => item.name)
	.sort();

for (const release of releases) {
	const version = release.slice(1);
	const manifest = manifestFor(version);
	if (!manifest) {
		fail("assets/docs-portal.js", `MANIFESTS has no entry for ${version}`);
		continue;
	}

	const index = read(`${release}/index.html`);
	if (/data-catalog-search/.test(index)) {
		if (!/data-catalog-clear/.test(index)) fail(`${release}/index.html`, "chapter search has no clear-search recovery action");
		if (!/id="catalog-result-count"/.test(index) || !/aria-describedby="catalog-result-count"/.test(index)) {
			fail(`${release}/index.html`, "chapter search is not associated with its result count");
		}
	}
	const catalogOrder = [...index.matchAll(/href="pages\/([^"#]+)\.html"/g)].map(m => m[1]);
	const pageFiles = readdirSync(join(DOCS, release, "pages"))
		.filter(name => name.endsWith(".html"))
		.map(name => name.replace(/\.html$/, ""));

	const companionBlock = new RegExp(`"${version}":\\s*\\{([\\s\\S]*?)\\n\\t\\t\\},`).exec(portal.slice(portal.indexOf("const COMPANIONS")));
	const companions = companionBlock ? [...companionBlock[1].matchAll(/(?:^|\n)\s*(?:"([^"]+)"|([A-Za-z][\w-]*))\s*:/g)].map(m => m[1] || m[2]) : [];

	const manifestSlugs = manifest.map(item => item.slug);
	if (manifestSlugs.join("|") !== catalogOrder.join("|")) {
		fail(
			`${release}/index.html`,
			`catalog order does not match MANIFESTS\n      catalog:  ${catalogOrder.join(", ")}\n      manifest: ${manifestSlugs.join(", ")}`,
		);
	}

	const known = new Set([...manifestSlugs, ...companions]);
	for (const slug of pageFiles) {
		if (!known.has(slug)) fail(`${release}/pages/${slug}.html`, "page exists but is in neither MANIFESTS nor COMPANIONS");
	}
	for (const slug of manifestSlugs) {
		if (!pageFiles.includes(slug)) fail("assets/docs-portal.js", `MANIFESTS lists ${release}/${slug}, which has no page file`);
	}

	/* --- 2. One chapter, one name, on every surface --------------------------- */

	const cardTitles = new Map();
	for (const card of index.matchAll(/<a class="(?:doc-list-item|minor-improvement-item)"\s+href="pages\/([^"#]+)\.html"[\s\S]*?<\/a>/g)) {
		const title = /<strong>([\s\S]*?)<\/strong>/.exec(card[0]);
		if (title) cardTitles.set(card[1], stripTags(title[1]));
	}

	for (const entry of manifest) {
		const file = `${release}/pages/${entry.slug}.html`;
		if (!existsSync(join(DOCS, file))) continue;
		const page = read(file);
		const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(page);
		const pageTitle = h1 ? stripTags(h1[1]) : null;
		const card = cardTitles.get(entry.slug);

		if (pageTitle && pageTitle !== entry.title) {
			fail(file, `<h1> "${pageTitle}" != MANIFESTS title "${entry.title}"`);
		}
		if (card && pageTitle && card !== pageTitle) {
			fail(`${release}/index.html`, `card title "${card}" != <h1> "${pageTitle}" (${entry.slug})`);
		}
	}

	/* --- 3. Counts quoted in prose and aria-labels match reality -------------- */

	const declared = /data-catalog-count[^>]*>(\d+)\s+chapters?</.exec(index);
	if (declared && Number(declared[1]) !== manifest.length) {
		fail(`${release}/index.html`, `catalog says ${declared[1]} chapters, MANIFESTS has ${manifest.length}`);
	}

	const portalIndex = read("index.html");
	const entry = new RegExp(`<a class="version-entry[^"]*" href="${release}/index\\.html"[\\s\\S]*?</a>`).exec(portalIndex);
	const label = entry && /<span class="visually-hidden">, (\d+) chapters<\/span>/.exec(entry[0]);
	if (entry && !label) fail("index.html", `portal entry for ${version} does not state its chapter count`);
	if (label && Number(label[1]) !== manifest.length) {
		fail("index.html", `portal entry claims ${label[1]} chapters for ${version}, MANIFESTS has ${manifest.length}`);
	}
	if (entry && /aria-label=/.test(entry[0].slice(0, entry[0].indexOf(">")))) {
		fail("index.html", `portal entry for ${version} must take its name from its visible text, not aria-label`);
	}

	/* The overview's change map must link every numbered chapter. */
	const overviewPath = `${release}/pages/overview.html`;
	if (existsSync(join(DOCS, overviewPath))) {
		const overview = read(overviewPath);
		for (const slug of manifestSlugs) {
			if (slug === "overview") continue;
			if (!overview.includes(`href="${slug}.html`)) fail(overviewPath, `does not link numbered chapter ${slug}`);
		}
		/* ...and name every live companion. Redirect stubs (meta refresh) have moved
		   into a chapter and are not companions a reader can open. */
		for (const slug of companions) {
			if (slug === "overview") continue;
			const file = `${release}/pages/${slug}.html`;
			if (!existsSync(join(DOCS, file)) || /<meta\s+http-equiv="refresh"/i.test(read(file))) continue;
			if (!overview.includes(`href="${slug}.html`)) fail(overviewPath, `does not link companion page ${slug}`);
		}
	}
}

/* --- 4. The v0.8.5 legacy redirect still covers every chapter -------------- */

const shimPath = "v0.8.5/complete.html";
if (existsSync(join(DOCS, shimPath))) {
	const shim = read(shimPath);
	const slugs = [...(/const slugs = \[([\s\S]*?)\];/.exec(shim)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
	const manifest = manifestFor("0.8.5")?.map(item => item.slug) ?? [];
	const missing = manifest.filter(slug => !slugs.includes(slug));
	const extra = slugs.filter(slug => !manifest.includes(slug));
	if (missing.length) fail(shimPath, `legacy redirect is missing: ${missing.join(", ")}`);
	if (extra.length) fail(shimPath, `legacy redirect points at unknown chapters: ${extra.join(", ")}`);
}

/* --- 5. Links, anchors and ids ------------------------------------------- */

const idsOf = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);

for (const file of htmlFiles) {
	const html = read(file);
	const ids = idsOf(html);
	const seen = new Set();
	for (const id of ids) {
		if (seen.has(id)) fail(file, `duplicate id="${id}"`);
		seen.add(id);
	}

	for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
		if (/^(https?:|mailto:|data:|javascript:)/.test(href)) continue;
		const [path, fragment] = href.split("#");
		if (path) {
			const target = resolve(DOCS, dirname(file), decodeURIComponent(path));
			if (!existsSync(target)) {
				fail(file, `broken link -> ${href}`);
				continue;
			}
			if (fragment && target.endsWith(".html")) {
				const targetIds = idsOf(readFileSync(target, "utf8"));
				if (!targetIds.includes(decodeURIComponent(fragment))) {
					fail(file, `broken cross-page anchor -> ${href} (no #${fragment} in ${relative(DOCS, target)})`);
				}
			}
		} else if (fragment && !seen.has(decodeURIComponent(fragment))) {
			fail(file, `broken anchor -> #${fragment}`);
		}
	}

	if (!/name="description"/.test(html) && !/name="robots"/.test(html)) {
		fail(file, 'no <meta name="description"> (and not marked noindex)');
	}

	/* Prose apostrophes are typographic (&rsquo;). Code, pre, script and style
	   content and attribute values keep straight quotes. */
	if (file.startsWith("v0.8.6/")) {
		const skip = { pre: 0, code: 0, script: 0, style: 0 };
		for (const [token] of html.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
			if (token.startsWith("<")) {
				const tag = /^<(\/?)([a-zA-Z0-9]+)/.exec(token);
				const name = tag?.[2].toLowerCase();
				if (name in skip && !token.endsWith("/>")) skip[name] += tag[1] ? -1 : 1;
				continue;
			}
			if (Object.values(skip).some(Boolean)) continue;
			const straight = /[A-Za-z]'[A-Za-z]/.exec(token);
			if (straight) fail(file, `straight apostrophe in prose ("${straight[0]}"); use &rsquo;`);
		}
	}

	/* Chapter headings and their rail links are plain sentence text, never
	   "4.2 Credit line" style numbered headings, so every chapter reads alike. */
	if (file.startsWith("v0.8.6/pages/")) {
		for (const [, level, inner] of html.matchAll(/<h([234])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
			const text = stripTags(inner);
			if (/^\d+(\.\d+)*\.?\s/.test(text)) fail(file, `numbered h${level} "${text}"; chapter headings are not numbered`);
		}
		for (const [, inner] of html.matchAll(/<a class="toc-link[^"]*"[^>]*>([\s\S]*?)<\/a\s*>/g)) {
			const text = stripTags(inner);
			if (/^\d+(\.\d+)*\.?\s/.test(text)) fail(file, `numbered rail link "${text}"; rail links match their unnumbered headings`);
		}
	}

	/* Mermaid treats semicolons as statement delimiters, including semicolons
	   embedded in sequence message and note labels. The runtime otherwise renders
	   an error SVG that looks like a valid diagram node to the page shell. */
	const mermaidBlocks = [...html.matchAll(/<pre\b([^>]*)><code[^>]*class="[^"]*\blanguage-mermaid\b[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g)];

	/* Each v0.8.6 diagram carries its drawn size so the loading placeholder can
	   reserve the right height. The values are the rendered mermaid SVG viewBox
	   (width height, rounded up); regenerate them with
	   .better-ui-app/20260929-2118-docs-portal/fixes/scratch-007/measure.mjs --apply
	   after editing a diagram. */
	if (file.startsWith("v0.8.6/pages/")) {
		mermaidBlocks.forEach((block, diagramIndex) => {
			const size = /\sdata-diagram-size="([^"]*)"/.exec(block[1])?.[1];
			if (!size || !/^[1-9]\d* [1-9]\d*$/.test(size)) {
				fail(file, `Mermaid diagram ${diagramIndex + 1} needs data-diagram-size="W H" (two positive integers from the rendered viewBox)`);
			}
		});
	}
	mermaidBlocks.forEach((block, diagramIndex) => {
		const source = decodeHtmlEntities(block[2]);
		if (/^\s*stateDiagram/.test(source)) {
			source.split("\n").forEach((line, lineIndex) => {
				const transition = /-->[^:]*:(.*)$/.exec(line);
				if (!transition || !transition[1].includes(";")) return;
				fail(file, `Mermaid state diagram ${diagramIndex + 1}, line ${lineIndex + 1}: semicolon in stateDiagram label splits the statement`);
			});
			return;
		}
		if (!/^\s*sequenceDiagram\b/.test(source)) return;

		source.split("\n").forEach((line, lineIndex) => {
			const labelStart = line.indexOf(":");
			if (labelStart === -1 || !line.slice(labelStart + 1).includes(";")) return;
			fail(
				file,
				`Mermaid sequence diagram ${diagramIndex + 1}, line ${lineIndex + 1} has a semicolon in label text; use punctuation that Mermaid 10.9.3 does not parse as a statement delimiter`,
			);
		});
	});
}

/* --- 6. Assets the pages depend on actually ship --------------------------- */

for (const asset of [
	"assets/vendor/mermaid.min.js",
	"assets/fonts/manrope-latin.woff2",
	"assets/fonts/inter-latin.woff2",
	"assets/fonts/jetbrains-mono-latin.woff2",
]) {
	if (!existsSync(join(DOCS, asset))) fail(asset, "missing vendored asset referenced by the stylesheets/scripts");
}

const css = read("v0.8.6/assets/v086-docs.css") + read("assets/docs-portal.css");
if (/@import\s+url\(\s*["']?https?:/.test(css)) fail("stylesheets", "remote @import — the site must not depend on a third-party origin");
if (/cdn\.jsdelivr|unpkg\.com|fonts\.googleapis/.test(portal + read("v0.8.6/assets/v086-docs.js"))) {
	fail("scripts", "third-party CDN reference — the site must not depend on a third-party origin");
}
if (/data-rail-tab|data-rail-search|Search chapters/.test(portal)) {
	fail("assets/docs-portal.js", 'reader navigation must remain a single "On this page" outline');
}

/* --- report --------------------------------------------------------------- */

if (problems.length) {
	console.error(`\n docs check failed — ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
	for (const { where, message } of problems) console.error(`  ${where}\n    ${message}\n`);
	process.exit(1);
}
console.log(` docs check passed — ${htmlFiles.length} pages, ${releases.join(", ")}`);
