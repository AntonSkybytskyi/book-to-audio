import type { Snapshot } from "./api";

/**
 * Decides which of a full load and a live event is newer, by sequence number, so a
 * slow answer cannot undo progress that an event already showed, and an event that an
 * answer already includes is not applied twice. A sequence number of 0 means "not
 * known" (an answer without the header) and is always accepted.
 */
export class SeqGate {
  /** Sequence number of the newest load applied. */
  private snapshot = 0;
  /** Sequence number of the newest event applied. */
  private event = 0;
  private epoch = 0;
  /** Newest event that arrived while there was nothing to apply it to. */
  private early = 0;

  get snapshotSeq(): number {
    return this.snapshot;
  }

  /** The newest number seen, from either. */
  get highest(): number {
    return Math.max(this.snapshot, this.event);
  }

  /**
   * True if the load should be shown: no event newer than it has been applied. `force`
   * takes it anyway, for a load that keeps being overtaken.
   */
  acceptSnapshot(seq: number, force = false): boolean {
    if (seq <= 0) return true;
    if (seq < this.event && !force) return false;
    this.snapshot = seq;
    return true;
  }

  /** True if the event is new: neither included in the last load nor seen before. */
  acceptEvent(seq: number): boolean {
    if (seq <= this.highest) return false;
    this.event = seq;
    return true;
  }

  /** An event arrived before the first load, so it could not be applied. */
  noteEarlyEvent(seq: number): void {
    this.early = Math.max(this.early, seq);
  }

  /** True once if events came before the load that the load (numbered `seq`) does not include. */
  takeCatchUp(seq: number): boolean {
    const behind = seq > 0 && this.early > seq;
    this.early = 0;
    return behind;
  }

  /** Forgets everything, for a server whose numbers do not continue from the old one's. */
  reset(): void {
    this.snapshot = 0;
    this.event = 0;
    this.early = 0;
  }

  /**
   * Call with the current connection (`epoch` changes with every new connection and
   * `connectSeq` is the newest event number the server had when it was made). A server
   * that restarted with its clock behind starts below what this gate has seen, and every
   * answer and event would be thrown away as old; so the gate starts over.
   */
  sync(epoch: number, connectSeq: number): void {
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    if (connectSeq > 0 && connectSeq < this.highest) this.reset();
  }
}

/** Waits before each repeat of a load that events overtook. After these, the next answer is taken as it is. */
export const OVERTAKEN_DELAYS_MS: readonly number[] = [50, 120, 250];

/**
 * Loads until the answer can be shown. An answer older than an event already applied is
 * dropped and asked for again after a short wait; if that keeps happening (events for
 * other books arrive faster than answers), the last answer is taken anyway, because a
 * view that is a moment behind is fixed by the next event and one that never loads is not.
 */
export async function loadUntilCurrent<T>(
  load: () => Promise<Snapshot<T>>,
  gate: SeqGate,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delays: readonly number[] = OVERTAKEN_DELAYS_MS,
): Promise<Snapshot<T>> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = await load();
    if (gate.acceptSnapshot(snapshot.seq, attempt >= delays.length)) return snapshot;
    await sleep(delays[attempt] ?? 0);
  }
}
