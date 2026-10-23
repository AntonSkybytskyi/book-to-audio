/** A reading of the meter at one moment; hand it back to `averageSince`. */
export interface MeterReading {
  at: number;
  integral: number;
}

/**
 * How many workers are busy, weighted by time. A chapter's reading time only says something about
 * the engine when it is known how many other chapters were being read at the same time.
 */
export class ConcurrencyMeter {
  private busy = 0;
  private integral = 0;
  private lastAt: number;

  constructor(private readonly now: () => number) {
    this.lastAt = now();
  }

  /** A worker starts a chapter. */
  enter(): MeterReading {
    this.advance();
    this.busy++;
    return this.reading();
  }

  /** A worker is done with its chapter. */
  leave(): void {
    this.advance();
    this.busy = Math.max(0, this.busy - 1);
  }

  /** The average number of busy workers from `since` until now (the current number if no time passed). */
  averageSince(since: MeterReading): number {
    this.advance();
    const span = this.lastAt - since.at;
    return span > 0 ? (this.integral - since.integral) / span : Math.max(1, this.busy);
  }

  private reading(): MeterReading {
    return { at: this.lastAt, integral: this.integral };
  }

  private advance(): void {
    const at = this.now();
    this.integral += this.busy * (at - this.lastAt);
    this.lastAt = at;
  }
}
