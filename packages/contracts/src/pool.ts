export type PoolStateName = "running" | "paused";
/** `failures`: chapters kept failing. `disk`: the disk is nearly full. */
export type PauseCause = "failures" | "disk";

/** `GET /api/pool` and the `pool` event. */
export interface PoolStatus {
  /** `paused` until the owner resumes: after three chapters failed in a row, or when the disk is full. */
  state: PoolStateName;
  /** Why the pool paused. */
  error: string | null;
  cause: PauseCause | null;
  /** Workers wanted by the settings. */
  workers: number;
  /** Workers converting a chapter right now. */
  activeWorkers: number;
  /** The speed benchmark has the pool: running chapters finish, none starts until it is done. */
  held: boolean;
}
