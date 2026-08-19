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
	const label = new RegExp(`aria-label="Open the [^"]*${version.replace(/\./g, "\\.")} changelog, (\\d+) chapters"`).exec(portalIndex);
	if (label && Number(label[1]) !== manifest.length) {
		fail("index.html", `portal aria-label claims ${label[1]} chapters for ${version}, MANIFESTS has ${manifest.length}`);
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

	/* Mermaid treats semicolons as statement delimiters, including semicolons
	   embedded in sequence message and note labels. The runtime otherwise renders
	   an error SVG that looks like a valid diagram node to the page shell. */
	const mermaidBlocks = [...html.matchAll(/<pre><code[^>]*class="[^"]*\blanguage-mermaid\b[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g)];
	mermaidBlocks.forEach((block, diagramIndex) => {
		const source = decodeHtmlEntities(block[1]);
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
