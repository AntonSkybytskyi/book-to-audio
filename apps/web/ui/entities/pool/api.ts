import type { PoolStatus } from "@book-to-audio/contracts";
import { requestSnapshot } from "@/ui/shared/api/request";

export type { PoolStatus } from "@book-to-audio/contracts";

export const getPool = () => requestSnapshot<PoolStatus>("/api/pool");
export const resumePool = () => requestSnapshot<PoolStatus>("/api/pool/resume", { method: "POST" });
