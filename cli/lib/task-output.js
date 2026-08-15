// In-process seam used only while an operator task calls legacy command modules.
// Child-process adapters read the current sink so their output becomes task evidence
// instead of bypassing the progress renderer.
let currentSink = null;

export function taskOutputSink() {
	return currentSink;
}

export async function withTaskOutputSink(sink, action) {
	if (currentSink) throw new Error("A task output sink is already active");
	currentSink = sink;
	try {
		return await action();
	} finally {
		currentSink = null;
	}
}
