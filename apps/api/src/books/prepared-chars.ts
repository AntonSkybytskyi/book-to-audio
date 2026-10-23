import type { TextPreparer } from "../convert/chapter-text.js";
import { TtsError } from "../tts/engine.js";

/** Time a book's count may take, from its first text rule run, before the rest are counted by their raw length. */
export const COUNT_BUDGET_MS = 60_000;

/** The time budget of one book's count, which only runs once the rules have really started on it. */
export class CountBudget {
  private startedAt: number | null = null;

  constructor(
    private readonly budgetMs = COUNT_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The first rule run began (waiting behind other work does not count). */
  start(): void {
    this.startedAt ??= this.now();
  }

  get exceeded(): boolean {
    return this.startedAt !== null && this.now() - this.startedAt > this.budgetMs;
  }
}

export interface CountOptions {
  /** Checked before each text: true ends the count with an `aborted` error (the book changed or is gone). */
  shouldStop?: () => boolean;
  /** Counts the time. Without one, the clock starts at the first call to `prepare` made here. */
  budget?: CountBudget;
}

/** The characters of one text: exact, or the raw length as a stand-in when the rules could not be run. */
export interface Counted {
  chars: number;
  approx: boolean;
}

/**
 * How many characters the engine would be given for each text after the text rules, in the
 * book's language: the length the speech rate is measured against. When the rules give up on a text
 * (they time out or run out of memory) or the budget is used up, that text and the rest are counted at
 * their raw length and marked `approx`, and no more rules are started: a book that defeats them costs
 * one time limit, not one per chapter. Cancelling rejects.
 */
export async function countPreparedDetailed(
  texts: readonly string[],
  language: string,
  maxChars: number,
  prepare: TextPreparer,
  signal?: AbortSignal,
  { shouldStop, budget: given }: CountOptions = {},
): Promise<Counted[]> {
  const budget = given ?? new CountBudget();
  const counts: Counted[] = [];
  let giveUp = false;
  for (const text of texts) {
    if (signal?.aborted || shouldStop?.()) throw new TtsError("aborted", "The count was cancelled");
    if (budget.exceeded) giveUp = true;
    if (giveUp) {
      counts.push({ chars: text.length, approx: true });
      continue;
    }
    try {
      if (!given) budget.start();
      const chunks = await untilAborted(prepare(text, language, maxChars, signal), signal);
      counts.push({ chars: chunks.reduce((sum, chunk) => sum + chunk.length, 0), approx: false });
    } catch (error) {
      if (error instanceof TtsError && error.code === "aborted") throw error;
      giveUp = true;
      counts.push({ chars: text.length, approx: true });
    }
  }
  return counts;
}

/** `countPreparedDetailed`, for callers that only want the numbers. */
export async function countPrepared(
  texts: readonly string[],
  language: string,
  maxChars: number,
  prepare: TextPreparer,
  signal?: AbortSignal,
  options?: CountOptions,
): Promise<number[]> {
  const counted = await countPreparedDetailed(texts, language, maxChars, prepare, signal, options);
  return counted.map((c) => c.chars);
}

/** The promise's outcome, or an `aborted` error as soon as the signal fires (a preparer need not notice it). */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TtsError("aborted", "The count was cancelled"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
