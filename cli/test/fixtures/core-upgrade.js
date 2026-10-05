import { prepareStandardCoreUpgrade } from "../../tasks/core-upgrade.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

export async function coreUpgradeFixture(t, kind = "eoa") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-lifecycle-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const config = read(new URL("../../../deployment-tooling/examples/core-upgrade.base-example.input.json", import.meta.url));
	config.governance.signerMode = kind === "safe" ? "safe-file" : "hardhat-keystore";
	config.governance.kind = kind;
	delete config.governance.ledgerDerivation;
	if (kind === "eoa") config.governance.signerKey = "GOVERNANCE_TEST";
	for (const dir of ["contracts", "cli", "tasks/config"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
	fs.writeFileSync(path.join(root, "contracts/Release.sol"), "// reviewed fixture\n");
	fs.writeFileSync(path.join(root, "cli/source.js"), "// runner fixture\n");
	fs.writeFileSync(path.join(root, ".gitignore"), "tasks/data/\n.symmio/\n");
	const source = path.join(root, "tasks/config/core-upgrade.fixture.input.json");
	write(source, config);
	const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git(["init", "-q"]);
	git(["add", "contracts", "cli", "tasks/config", ".gitignore"]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "test: seed fixture"]);
	git(["tag", config.release.ref]);
	git(["tag", config.release.baselineRef]);
	const input = await prepareStandardCoreUpgrade({ root, ui: { select: async () => source, note() {} } });
	return { root, config, input };
}
