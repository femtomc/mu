export class SerializedMutationExecutor {
	#tail: Promise<unknown> = Promise.resolve();

	public run<T>(fn: () => Promise<T> | T): Promise<T> {
		const run = this.#tail.then(async () => await fn());
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}
