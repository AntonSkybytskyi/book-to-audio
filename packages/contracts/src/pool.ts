export type PoolStateName = "running" | "paused";
/** `failures`: chapters kept failing. `disk`: the disk is nearly full. */
export type PauseCause = "failures" | "disk";

/** The workers of one TTS service. */
export interface ServicePoolStatus {
  /** The service's name in `TTS_SERVICES`. */
  id: string;
  /** `paused` after three of its chapters failed in a row, until the owner resumes it. */
  state: PoolStateName;
  /** Why it paused. */
  error: string | null;
  /** The service answered the last time it was asked; while it does not, it has no workers. */
  reachable: boolean;
  /** Workers in use: the number set in the settings, else the one the service reports. */
  workers: number;
  /** Requests the service says it handles at once; 0 until it has answered. */
  reportedWorkers: number;
  /** Workers converting a chapter right now. */
  activeWorkers: number;
}

/** `GET /api/pool` and the `pool` event. */
export interface PoolStatus {
  /** `paused` while the disk is full, until the owner resumes. Each service also pauses on its own. */
  state: PoolStateName;
  /** Why the pool paused. */
  error: string | null;
  cause: PauseCause | null;
  /** Workers in use, all services together. */
  workers: number;
  /** Workers converting a chapter right now, all services together. */
  activeWorkers: number;
  /** The speed benchmark has the pool: running chapters finish, none starts until it is done. */
  held: boolean;
  services: ServicePoolStatus[];
}
