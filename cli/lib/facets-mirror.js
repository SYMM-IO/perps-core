// The plain-JS CLI cannot import the TypeScript deploy constants without introducing a
// build step. Keep the expected deployed count here, and parse the source at runtime so a
// facet-list change cannot silently weaken `symmio status`.
import { projectPath } from "./paths.js";
import fs from "node:fs";

const CONSTANTS_TS = projectPath("tasks", "deploy", "constants.ts");

// FacetNames contains facets added by diamondCut. DiamondCutFacet is installed separately.
export const EXPECTED_CORE_FACETS = 32;

export function checkFacetMirrorDrift() {
	if (!fs.existsSync(CONSTANTS_TS)) {
		return { checked: false, problems: ["tasks/deploy/constants.ts not found — cannot verify the expected core facet count"] };
	}

	const src = fs.readFileSync(CONSTANTS_TS, "utf8");
	const block = src.match(/export const FacetNames\s*=\s*\[([\s\S]*?)\n\]/);
	if (!block) {
		return { checked: false, problems: ["could not parse FacetNames from tasks/deploy/constants.ts"] };
	}

	const configured = [...block[1].matchAll(/^\s*"(?:[^"\\]|\\.)+",?\s*(?:\/\/.*)?$/gm)].length + 1;
	if (configured !== EXPECTED_CORE_FACETS) {
		return {
			checked: true,
			problems: [`tasks/deploy/constants.ts expects ${configured} deployed core facets; the CLI mirror expects ${EXPECTED_CORE_FACETS}`],
		};
	}

	return { checked: true, problems: [] };
}
