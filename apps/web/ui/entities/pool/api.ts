import { requestSnapshot } from "@/ui/shared/api/request";

export interface PoolStatus {
  /** `paused` until the owner resumes: after three chapters failed in a row, or when the disk is full. */
  state: "running" | "paused";
  /** Why the pool paused. */
  error: string | null;
  cause: "failures" | "disk" | null;
  workers: number;
  activeWorkers: number;
  /** A speed test has the pool: chapters wait until it is done. */
  held: boolean;
}

export const getPool = () => requestSnapshot<PoolStatus>("/api/pool");
export const resumePool = () => requestSnapshot<PoolStatus>("/api/pool/resume", { method: "POST" });
