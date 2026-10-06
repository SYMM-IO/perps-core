export class MultiError extends Error {
	readonly errors: readonly unknown[]

	constructor(errors: readonly unknown[], message: string) {
		super(message)
		this.name = "AggregateError"
		this.errors = [...errors]
	}
}
