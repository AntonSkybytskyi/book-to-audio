"use client";

import { useState } from "react";
import { resumePool } from "@/ui/entities/pool/api";
import { cx } from "@/ui/shared/lib/cx";
import { useApplyPoolSnapshot, usePool } from "@/ui/entities/pool/use-pool";
import { Button } from "@/ui/shared/ui/Button";

const BANNER = "border-b border-l-[0.35rem] border-rule bg-paper-raised";
const INNER =
  "mx-auto flex max-w-column items-center justify-between gap-6 px-gutter py-4 max-sm:flex-col max-sm:items-stretch";
const TEXT = "grid min-w-0 gap-[0.35rem] text-[0.95rem]";

/** Shown on every page while the pool is paused because chapters kept failing. */
export function PoolBanner() {
  const pool = usePool();
  const applyPoolSnapshot = useApplyPoolSnapshot();
  const [resuming, setResuming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (pool?.held && pool.state !== "paused") {
    return (
      <section className={cx(BANNER, "border-l-accent")} role="status">
        <div className={INNER}>
          <p className={TEXT}>
            <strong>Measuring how fast this computer reads aloud.</strong>{" "}
            {pool.activeWorkers > 0
              ? "Chapters that are already being read finish first; conversion carries on as soon as the speed test is done, which takes a few minutes at most."
              : "No chapter is being read now. Conversion carries on as soon as the speed test is done, which takes a few minutes at most."}
          </p>
        </div>
      </section>
    );
  }
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
    <section
      className={cx(BANNER, "border-l-danger")}
      role="alert"
      aria-labelledby="pool-banner-title"
    >
      <div className={INNER}>
        <div className={TEXT}>
          <h2 id="pool-banner-title" className="font-serif text-[1.2rem] font-semibold text-danger">
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
            <p className="text-ink-muted wrap-anywhere">
              Last error: <q>{pool.error}</q> Look at the app&apos;s logs for the details.
            </p>
          )}
          {failure && <p className="text-danger">{failure}</p>}
        </div>
        <Button onClick={resume} disabled={resuming}>
          {resuming ? "Resuming…" : "Resume all"}
        </Button>
      </div>
    </section>
  );
}
