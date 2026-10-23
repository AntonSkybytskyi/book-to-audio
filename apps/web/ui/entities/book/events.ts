import type {
  AppEvent,
  BenchmarkEvent,
  BookAddedEvent,
  BookCountedEvent,
  BookDeletedEvent,
  BookEvent,
  ChapterEvent,
  OutputsEvent,
  PoolEvent,
} from "@book-to-audio/contracts";
import type { StreamEvent } from "@/ui/shared/api/events";

export type {
  BookAddedEvent,
  BookCountedEvent,
  BookDeletedEvent,
  BookEvent,
  ChapterEvent,
  OutputsEvent,
};

/** Every event that is not about the pool or the speed test is about a book, new ones included. */
export type BookLiveEvent = Exclude<AppEvent, PoolEvent | BenchmarkEvent>;

const BOOK_EVENT_TYPE_LIST = [
  "chapter",
  "book",
  "book-added",
  "book-deleted",
  "outputs",
  "book-counted",
] as const satisfies readonly BookLiveEvent["type"][];

// Fails to compile when a new book event is missing from the list, so the pages never drop it.
const everyBookEventListed: Exclude<
  BookLiveEvent["type"],
  (typeof BOOK_EVENT_TYPE_LIST)[number]
> extends never
  ? true
  : never = true;
void everyBookEventListed;

const BOOK_EVENT_TYPES: ReadonlySet<string> = new Set(BOOK_EVENT_TYPE_LIST);

export const isBookEvent = (event: StreamEvent): event is BookLiveEvent =>
  BOOK_EVENT_TYPES.has(event.type);
