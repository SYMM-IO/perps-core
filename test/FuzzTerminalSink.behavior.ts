import { expect } from "chai"

import { createProcessTerminalSink } from "./utils/FuzzLogger.js"

const CLEAR_LINE = "\r\u001b[2K"
const CURSOR_UP = "\u001b[1A"
const CLEAR_TWO_LINES = `${CLEAR_LINE}${CURSOR_UP}${CLEAR_LINE}`
const CLEAR_THREE_LINES = `${CLEAR_LINE}${CURSOR_UP}${CLEAR_LINE}${CURSOR_UP}${CLEAR_LINE}`

function streamHarness(columns?: number): {
	stream: NodeJS.WriteStream
	writes: string[]
	setColumns: (value?: number) => void
} {
	const writes: string[] = []
	const stream = {
		columns,
		write(chunk: string): boolean {
			writes.push(chunk)
			return true
		},
	}

	return {
		stream: stream as NodeJS.WriteStream,
		writes,
		setColumns: value => {
			stream.columns = value
		},
	}
}

export function shouldBehaveLikeFuzzTerminalSink(): void {
	it("uses one stream write per distinct replacement and batches clearing with the new frame", function () {
		const { stream, writes } = streamHarness()
		const terminal = createProcessTerminalSink(stream)

		terminal.replace(["alpha", "beta"])
		expect(writes).to.deep.equal(["alpha\nbeta"])

		terminal.replace(["gamma", "delta"])
		expect(writes).to.deep.equal(["alpha\nbeta", `${CLEAR_TWO_LINES}gamma\ndelta`])
	})

	it("suppresses replacements whose rendered frame is unchanged", function () {
		const { stream, writes } = streamHarness()
		const terminal = createProcessTerminalSink(stream)

		terminal.replace(["stable", "frame"])
		terminal.replace(["stable", "frame"])

		expect(writes).to.deep.equal(["stable\nframe"])
	})

	it("clears every old line when a frame shrinks and tracks the shorter replacement", function () {
		const { stream, writes } = streamHarness()
		const terminal = createProcessTerminalSink(stream)

		terminal.replace(["first", "second", "third"])
		terminal.replace(["short"])
		terminal.replace(["next"])

		expect(writes).to.deep.equal(["first\nsecond\nthird", `${CLEAR_THREE_LINES}short`, `${CLEAR_LINE}next`])
	})

	it("clears physical rows created when the terminal becomes narrower", function () {
		const { stream, writes, setColumns } = streamHarness(12)
		const terminal = createProcessTerminalSink(stream)

		terminal.replace(["ABCDEFGHIJK"])
		setColumns(5)
		terminal.replace(["next"])

		expect(writes).to.deep.equal(["ABCDEFGHIJK", `${CLEAR_THREE_LINES}next`])
	})

	it("makes clear idempotent before and after a rendered frame", function () {
		const { stream, writes } = streamHarness()
		const terminal = createProcessTerminalSink(stream)

		terminal.clear()
		expect(writes).to.deep.equal([])

		terminal.replace(["first", "second"])
		terminal.clear()
		terminal.clear()

		expect(writes).to.deep.equal(["first\nsecond", CLEAR_TWO_LINES])
	})

	it("forwards live stream columns and falls back to eighty when unavailable", function () {
		const { stream, setColumns } = streamHarness(132)
		const terminal = createProcessTerminalSink(stream)

		expect(terminal.columns).to.equal(132)
		setColumns(72)
		expect(terminal.columns).to.equal(72)
		setColumns(0)
		expect(terminal.columns).to.equal(80)
		setColumns(undefined)
		expect(terminal.columns).to.equal(80)
	})
}
