import type { AppEvent, ChapterEvent, EventBus } from "./bus.js";

interface Slot {
  lastSentAt: number;
  pending: ChapterEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Publishes chapter progress at most once per interval per chapter. An update
 * that arrives too early is held and sent when the interval ends, so the last
 * value always gets through. Anything else is published at once.
 */
export class ProgressPublisher {
  private readonly slots = new Map<string, Slot>();

  constructor(
    private readonly bus: EventBus,
    private readonly intervalMs = 500,
  ) {}

  /** Progress of a running chapter: throttled. */
  progress(event: ChapterEvent): void {
    const key = `${event.bookId}/${event.position}`;
    const slot = this.slots.get(key) ?? {
      lastSentAt: Number.NEGATIVE_INFINITY,
      pending: null,
      timer: null,
    };
    this.slots.set(key, slot);

    const wait = slot.lastSentAt + this.intervalMs - Date.now();
    if (wait <= 0) {
      this.send(slot, event);
      return;
    }
    slot.pending = event;
    slot.timer ??= setTimeout(() => {
      slot.timer = null;
      if (slot.pending) this.send(slot, slot.pending);
    }, wait);
  }

  /** Any other event. A held progress update for the chapter is dropped: this one is newer. */
  publish(event: AppEvent): void {
    if (event.type === "chapter") this.drop(`${event.bookId}/${event.position}`);
    this.bus.publish(event);
  }

  /** Forgets a chapter that is no longer running, so its slot does not stay in memory. */
  forget(bookId: string, position: number): void {
    this.drop(`${bookId}/${position}`);
  }

  /** Cancels timers, for shutdown. */
  stop(): void {
    for (const key of this.slots.keys()) this.drop(key);
  }

  private send(slot: Slot, event: ChapterEvent): void {
    slot.pending = null;
    slot.lastSentAt = Date.now();
    this.bus.publish(event);
  }

  private drop(key: string): void {
    const slot = this.slots.get(key);
    if (slot?.timer) clearTimeout(slot.timer);
    this.slots.delete(key);
  }
}
