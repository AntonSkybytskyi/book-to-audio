/** Lets at most `limit` jobs run at once; the rest wait their turn in order. */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    // A waiter is handed the slot of the job that ended, so the count never dips (and a newcomer cannot
    // slip in ahead of it, nor can two start for one slot).
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
