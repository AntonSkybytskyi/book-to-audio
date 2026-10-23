/** Gives the pool back: workers take chapters again once every hold is released. Safe to call twice. */
export type Release = () => void;

interface Waiter {
  resolve(release: Release): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

const aborted = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new Error("The wait was cancelled");

/**
 * Lets one job (the speed benchmark) have the machine to itself: while the pool is held its workers
 * take no new chapters, so a conversion queued meanwhile starts the moment the hold is released.
 */
export class PoolGate {
  private holds = 0;
  private readonly waiters = new Set<Waiter>();

  /** `onChange` runs when the pool becomes held or free, so workers wake up and the state is announced. */
  constructor(private readonly onChange: () => void) {}

  get held(): boolean {
    return this.holds > 0;
  }

  /**
   * Holds the pool at once, so nothing new starts, then waits for the chapters that are being read
   * (`inFlight`) to finish. Cancelling the wait lifts the hold again.
   */
  async hold(inFlight: () => Promise<void>[], signal?: AbortSignal): Promise<Release> {
    const release = this.acquire();
    try {
      await untilAborted(Promise.allSettled(inFlight()), signal);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Waits for a moment when no chapter is being read and none is waiting, and holds the pool then. */
  holdWhenIdle(isIdle: () => boolean, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (!this.held && isIdle()) return Promise.resolve(this.acquire());
    return new Promise<Release>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(aborted(signal as AbortSignal));
      };
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** A worker found nothing to do: if the whole pool is idle, the first waiter gets its hold. */
  offerIdle(isIdle: () => boolean): void {
    if (this.held || !isIdle()) return;
    const [waiter] = this.waiters;
    if (!waiter) return;
    this.waiters.delete(waiter);
    waiter.cleanup();
    waiter.resolve(this.acquire());
  }

  private acquire(): Release {
    this.holds++;
    this.onChange();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.onChange();
    };
  }
}

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
