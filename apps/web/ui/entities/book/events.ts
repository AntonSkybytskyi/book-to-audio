import type {
  BookAddedEvent,
  BookCountedEvent,
  BookDeletedEvent,
  BookEvent,
  ChapterEvent,
  OutputsEvent,
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

export type BookLiveEvent =
  | ChapterEvent
  | BookEvent
  | BookAddedEvent
  | BookDeletedEvent
  | OutputsEvent
  | BookCountedEvent;

const BOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "chapter",
  "book",
  "book-added",
  "book-deleted",
  "outputs",
  "book-counted",
]);

export const isBookEvent = (event: StreamEvent): event is BookLiveEvent =>
  BOOK_EVENT_TYPES.has(event.type);
