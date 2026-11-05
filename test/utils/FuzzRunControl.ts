import type { FuzzRunMode, FuzzStopSignal } from "../models/FuzzLogTypes.js"

type StopListener = (signal: FuzzStopSignal) => void

export class FuzzStopController {
	private readonly listeners = new Set<StopListener>()
	private requestedSignal?: FuzzStopSignal

	get requested(): boolean {
		return this.requestedSignal !== undefined
	}

	get signal(): FuzzStopSignal | undefined {
		return this.requestedSignal
	}

	request(signal: FuzzStopSignal): boolean {
		if (this.requestedSignal !== undefined) return false
		this.requestedSignal = signal
		for (const listener of [...this.listeners]) {
			try {
				listener(signal)
			} catch {
				// A stop observer must not prevent the remaining cleanup observers.
			}
		}
		this.listeners.clear()
		return true
	}

	onStop(listener: StopListener): () => void {
		if (this.requestedSignal !== undefined) {
			listener(this.requestedSignal)
			return () => undefined
		}
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
}

export async function runFuzzRootLoop(
	options: {
		mode: FuzzRunMode
		rootActions: number
		stop: FuzzStopController
	},
	executeRoot: (index: number) => Promise<boolean | void>,
): Promise<number> {
	let completed = 0
	while (!options.stop.requested && (options.mode === "continuous" || completed < options.rootActions)) {
		const rootCompleted = await executeRoot(completed + 1)
		if (rootCompleted === false) break
		completed++
	}
	return completed
}

export type FuzzSignalTarget = {
	once(event: FuzzStopSignal, listener: () => void): unknown
	off(event: FuzzStopSignal, listener: () => void): unknown
}

export function installFuzzSignalHandlers(
	target: FuzzSignalTarget,
	stop: FuzzStopController,
	onFirstStop: StopListener = () => undefined,
): () => void {
	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		target.off("SIGINT", onSigint)
		target.off("SIGTERM", onSigterm)
	}
	const handle = (signal: FuzzStopSignal) => {
		if (!stop.request(signal)) return
		dispose()
		onFirstStop(signal)
	}
	const onSigint = () => handle("SIGINT")
	const onSigterm = () => handle("SIGTERM")
	target.once("SIGINT", onSigint)
	target.once("SIGTERM", onSigterm)
	return dispose
}
