// Validate authored decisions and the actual renderer without changing prose.
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "annotation-decisions.json"), "utf8"));
const dataPath = path.join(root, "assets/docs-annotation-data.js");
const engine = fs.readFileSync(path.join(root, "assets/docs-annotations.js"), "utf8");
const runtime = {};
const issues = [];
const ids = new Set();
const norm = text => text.replace(/\s+/g, " ").trim();
const fileFor = key =>
	key.includes("/index") ? `${key}.html` : key.startsWith("v0.") ? `${key.split("/")[0]}/pages/${key.split("/")[1]}.html` : `${key}.html`;
const required = ["id", "form", "job", "readerGain", "sourceQuote", "whyExistingInsufficient", "whyThisForm", "repeatCheck", "removeWhen"];
for (const page of manifest.pages) {
	if (!page.reviewed || !page.readerTask?.trim()) issues.push(`${page.key}: missing editorial review/task`);
	const htmlPath = path.join(root, fileFor(page.key));
	if (!fs.existsSync(htmlPath)) {
		issues.push(`${page.key}: page missing`);
		continue;
	}
	const html = fs.readFileSync(htmlPath, "utf8");
	const dom = new JSDOM(html, { url: `http://127.0.0.1:4173/${fileFor(page.key)}`, runScripts: "outside-only" });
	const d = dom.window.document;
	const accepted = page.accepted || [];
	runtime[page.key] = [];
	for (const record of accepted) {
		for (const field of required)
			if (typeof record[field] !== "string" || !record[field].trim()) issues.push(`${page.key}/${record.id}: missing ${field}`);
		if (ids.has(record.id)) issues.push(`Duplicate id: ${record.id}`);
		ids.add(record.id);
		if (!["Guard", "Guide"].includes(record.job)) issues.push(`${record.id}: unknown reader job`);
		if (!["highlight", "underline", "note", "circle"].includes(record.form)) issues.push(`${record.id}: unknown form`);
		if (record.form === "note" ? !record.note?.trim() : !record.targetQuote?.trim()) issues.push(`${record.id}: missing note/target`);
		for (const link of record.links || []) {
			if (!record.note?.includes(link.label)) issues.push(`${record.id}: note link label missing`);
			const url = new URL(link.href, dom.window.location.href);
			if (url.origin !== dom.window.location.origin) {
				issues.push(`${record.id}: annotation link is not local`);
				continue;
			}
			const targetFile = path.join(root, url.pathname);
			if (!fs.existsSync(targetFile)) issues.push(`${record.id}: link file missing`);
			else if (
				url.hash &&
				!new JSDOM(fs.readFileSync(targetFile, "utf8")).window.document.getElementById(decodeURIComponent(url.hash.slice(1)))
			)
				issues.push(`${record.id}: link fragment missing`);
		}
		const { id, form, sourceQuote, targetQuote, sectionId, note, placement, links, beforeSelector } = record;
		runtime[page.key].push({
			id,
			form,
			sourceQuote,
			targetQuote: targetQuote || "",
			sectionId: sectionId || "",
			...(note ? { note } : {}),
			placement: placement || "mark",
			...(links?.length ? { links } : {}),
			...(beforeSelector ? { beforeSelector } : {}),
		});
	}
	const article = d.querySelector(".doc-article");
	const before = article && norm(article.textContent);
	const codeBefore = [...d.querySelectorAll("pre")].map(node => node.textContent);
	dom.window.__DOC_ANNOTATION_RECORDS__ = runtime;
	dom.window.eval(engine);
	const errors = JSON.parse(d.body.dataset.annotationsErrors || "[]");
	issues.push(...errors.map(error => `${page.key}/${error.id}: ${error.reason}`));
	if (+d.body.dataset.annotationsCount !== accepted.length) issues.push(`${page.key}: applied/expected mismatch`);
	for (const record of accepted.filter(record => record.form !== "note")) {
		const marked = [...d.querySelectorAll("span[data-annotation-id]")]
			.filter(node => node.dataset.annotationId === record.id)
			.map(node => node.textContent)
			.join("");
		if (norm(marked) !== norm(record.targetQuote)) issues.push(`${record.id}: marked glyphs do not equal complete target`);
	}
	const count = d.querySelectorAll("[data-annotation-id]").length;
	dom.window.eval(engine);
	if (d.querySelectorAll("[data-annotation-id]").length !== count) issues.push(`${page.key}: duplicate application`);
	d.querySelectorAll(".doc-annotation-note").forEach(node => node.remove());
	if (article && norm(article.textContent) !== before) issues.push(`${page.key}: original prose changed`);
	if (JSON.stringify(codeBefore) !== JSON.stringify([...d.querySelectorAll("pre")].map(node => node.textContent)))
		issues.push(`${page.key}: copyable code changed`);
	dom.window.close();
}
const htmlFiles = (dir => {
	const walk = dir =>
		fs
			.readdirSync(dir, { withFileTypes: true })
			.flatMap(entry =>
				entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".html") ? [path.join(dir, entry.name)] : [],
			);
	return walk(dir);
})(root);
const covered = new Set(manifest.pages.map(page => fileFor(page.key)).concat(manifest.redirects.map(page => page.path)));
for (const file of htmlFiles) if (!covered.has(path.relative(root, file))) issues.push(`Page not reviewed: ${path.relative(root, file)}`);
if (issues.length) {
	console.error(issues.join("\n"));
	process.exit(1);
}
const generated = await format(
	`// Generated from docs/annotation-decisions.json. Run node docs/check-annotations.mjs --write.\nwindow.__DOC_ANNOTATION_RECORDS__ = ${JSON.stringify(runtime, null, 2)};\n`,
	{ ...(await resolveConfig(dataPath)), filepath: dataPath },
);
if (process.argv.includes("--write")) fs.writeFileSync(dataPath, generated);
else if (!fs.existsSync(dataPath) || fs.readFileSync(dataPath, "utf8") !== generated) {
	console.error("Runtime data is stale. Run node docs/check-annotations.mjs --write.");
	process.exit(1);
}
console.log(
	JSON.stringify({
		reviewedPages: manifest.pages.length,
		redirects: manifest.redirects.length,
		accepted: ids.size,
		anchors: "unique",
		links: "valid",
		proseAndCode: "preserved",
		idempotent: true,
	}),
);
