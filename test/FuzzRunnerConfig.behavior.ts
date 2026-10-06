import { expect } from "chai"

import { resolveFuzzRunConfig } from "./FuzzRunner.js"
import { createFuzzRunLogger } from "./utils/FuzzLogger.js"

function fuzzEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		FUZZ_SEED: "profile-seed",
		...overrides,
	}
}

export function shouldBehaveLikeFuzzRunnerConfig(): void {
	describe("fuzz run profiles", function () {
		it("uses a responsive, lower-overhead profile for continuous soaking", function () {
			const config = resolveFuzzRunConfig({ env: fuzzEnv(), runMode: "continuous" })

			expect(config.runMode).to.equal("continuous")
			expect(config.userCount).to.equal(3)
			expect(config.hedgerCount).to.equal(2)
			expect(config.progressEvery).to.equal(1)
			expect(config.validationProbability).to.equal(0.2)
			expect(config.cornerEvery).to.equal(2)
		})

		it("keeps full validation as the bounded CI default", function () {
			const config = resolveFuzzRunConfig({ env: fuzzEnv(), runMode: "bounded" })

			expect(config.runMode).to.equal("bounded")
			expect(config.validationProbability).to.equal(1)
			expect(config.cornerEvery).to.equal(1)
		})

		it("derives defaults from the effective run mode rather than a conflicting environment mode", function () {
			const config = resolveFuzzRunConfig({
				env: fuzzEnv({ FUZZ_RUN_MODE: "continuous" }),
				runMode: "bounded",
			})

			expect(config.runMode).to.equal("bounded")
			expect(config.validationProbability).to.equal(1)
		})

		it("preserves explicit validation, progress, and seed overrides in deterministic replays", function () {
			const env = fuzzEnv({
				FUZZ_RUN_MODE: "continuous",
				FUZZ_PROGRESS_EVERY: "7",
				FUZZ_CORNER_EVERY: "4",
				VALIDATION_PROBABILITY: "0.35",
			})
			const first = resolveFuzzRunConfig({ env })
			const second = resolveFuzzRunConfig({ env })
			const replay = createFuzzRunLogger(first, { FUZZ_LOG_LEVEL: "quiet" }).replayCommand()

			expect(second).to.deep.equal(first)
			expect(first.seed).to.equal("profile-seed")
			expect(first.progressEvery).to.equal(7)
			expect(first.cornerEvery).to.equal(4)
			expect(first.validationProbability).to.equal(0.35)
			expect(replay).to.include("FUZZ_SEED=profile-seed")
			expect(replay).to.include("FUZZ_PROGRESS_EVERY=7")
			expect(replay).to.include("FUZZ_CORNER_EVERY=4")
			expect(replay).to.include("VALIDATION_PROBABILITY=0.35")
		})

		it("allows corner campaigns to be disabled explicitly", function () {
			const config = resolveFuzzRunConfig({
				env: fuzzEnv({ FUZZ_CORNER_EVERY: "0" }),
				runMode: "continuous",
			})

			expect(config.cornerEvery).to.equal(0)
		})
	})
}
