"use client";

import { useState } from "react";
import { resumePool } from "../_lib/api";
import { applyPoolSnapshot, usePool } from "../_lib/pool-store";
import styles from "./PoolBanner.module.css";
import shared from "./shared.module.css";

/** Shown on every page while the pool is paused because chapters kept failing. */
export function PoolBanner() {
  const pool = usePool();
  const [resuming, setResuming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!pool || pool.state !== "paused") return null;

  const resume = async () => {
    setResuming(true);
    setFailure(null);
    try {
      applyPoolSnapshot(await resumePool());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not resume.");
    } finally {
      setResuming(false);
    }
  };

  const disk = pool.cause === "disk";

  return (
    <section className={styles.banner} role="alert" aria-labelledby="pool-banner-title">
      <div className={styles.inner}>
        <div className={styles.text}>
          <h2 id="pool-banner-title" className={styles.title}>
            {disk
              ? "All conversion is paused: the disk is almost full"
              : "All conversion is paused"}
          </h2>
          {disk ? (
            <p>
              Free some space on the drive that holds the app&apos;s data. Resume carries on from
              the last saved part of each chapter.
            </p>
          ) : (
            <p>
              Three chapters in a row failed, so no book starts new chapters. Resume tries the
              waiting chapters again; chapters that already failed stay failed. (Pausing a single
              book is done on its page.)
            </p>
          )}
          {!disk && pool.error && (
            <p className={styles.reason}>
              Last error: <q>{pool.error}</q> Look at the app&apos;s logs for the details.
            </p>
          )}
          {failure && <p className={shared.error}>{failure}</p>}
        </div>
        <button type="button" className={shared.button} onClick={resume} disabled={resuming}>
          {resuming ? "Resuming…" : "Resume all"}
        </button>
      </div>
    </section>
  );
}
