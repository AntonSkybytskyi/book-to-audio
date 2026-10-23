/**
 * Runs tasks one after another per key. Pausing, regenerating and deleting a book each wait
 * for the others on the same book, so two requests cannot take the same chapters apart
 * at once (one discarding chunks that the other has just started writing).
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The tail never rejects, so one failed task does not stop the ones behind it.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
