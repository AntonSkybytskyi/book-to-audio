import type { PoolEvent } from "@book-to-audio/contracts";
import type { StreamEvent } from "@/ui/shared/api/events";

export type { PoolEvent };

export const isPoolEvent = (event: StreamEvent): event is PoolEvent => event.type === "pool";
