import type { StreamEvent } from "@/ui/shared/api/events";
import type { PoolStatus } from "./api";

export interface PoolEvent extends PoolStatus {
  type: "pool";
}

export const isPoolEvent = (event: StreamEvent): event is PoolEvent => event.type === "pool";
