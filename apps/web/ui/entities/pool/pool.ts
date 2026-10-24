import type { PoolStatus, ServicePoolStatus } from "./api";

/** Why no new chapter starts for a book: `all` conversion is paused (the disk), or its `service`. */
export type PauseReason = "all" | "service" | null;

export const servicePool = (
  pool: PoolStatus | null,
  service: string | undefined,
): ServicePoolStatus | undefined => pool?.services.find((s) => s.id === service);

/** The pause that holds up a book read by `service` (undefined when the book has no voice yet). */
export function pauseFor(pool: PoolStatus | null, service: string | undefined): PauseReason {
  if (pool?.state === "paused") return "all";
  return servicePool(pool, service)?.state === "paused" ? "service" : null;
}
