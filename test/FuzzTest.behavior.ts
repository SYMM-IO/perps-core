import { runFuzzSimulation } from "./FuzzRunner.js"

export function shouldBehaveLikeFuzzTest(): void {
	it("runs a bounded, replayable multi-actor model sequence", async function () {
		this.timeout(180_000)
		await runFuzzSimulation({ runMode: "bounded" })
	})
}
