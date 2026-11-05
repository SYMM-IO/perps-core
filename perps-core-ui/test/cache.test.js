import { suppliedProfile } from "../server/system.js";
import { createWorkspace } from "../server/workspace.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("saved snapshots restore for inspection without restoring a live provider or execution authority", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-cache-"));
	const file = path.join(root, `snapshot-${suppliedProfile.chainId}-${suppliedProfile.id}.json`);
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({ profile: suppliedProfile, chainId: suppliedProfile.chainId, nodes: [], edges: [], blockNumber: 123 }),
		);
		const workspace = createWorkspace({ stateRoot: root, taskRoot: root });
		assert.equal(workspace.status().snapshot.blockNumber, 123);
		assert.equal(workspace.status().connected, false);
		await assert.rejects(workspace.compare(), /Inspect/);
		workspace.select(suppliedProfile.id);
		assert.equal(workspace.status().connected, false);
		const mismatched = { ...suppliedProfile, chainId: 1 };
		fs.writeFileSync(file, JSON.stringify({ profile: mismatched, chainId: 1, nodes: [], edges: [] }));
		assert.equal(createWorkspace({ stateRoot: root, taskRoot: root }).status().snapshot, null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
