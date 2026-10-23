import type { PoolStatus } from "@book-to-audio/contracts";
import { requestSnapshot } from "@/ui/shared/api/request";

export type { PoolStatus, ServicePoolStatus } from "@book-to-audio/contracts";

export const getPool = () => requestSnapshot<PoolStatus>("/api/pool");
/** Resumes all conversion, or only the workers of one speech service. */
export const resumePool = (service?: string) =>
  requestSnapshot<PoolStatus>("/api/pool/resume", {
    method: "POST",
    ...(service === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify({ service }) }),
  });
