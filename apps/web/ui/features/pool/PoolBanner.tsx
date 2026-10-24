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
/** What `resume` is given to resume everything; no service has an empty name. */
const ALL = "";

/**
 * Shown on every page while conversion is held up: all of it because the disk is full, or the
 * chapters of one speech service because they kept failing or the service does not answer.
 */
export function PoolBanner() {
  const pool = usePool();
  const applyPoolSnapshot = useApplyPoolSnapshot();
  const [resuming, setResuming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!pool) return null;

  /** `ALL` resumes everything; a service name only that service. */
  const resume = async (what: string) => {
    setResuming(what);
    setFailure(null);
    try {
      applyPoolSnapshot(await resumePool(what === ALL ? undefined : what));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not resume.");
    } finally {
      setResuming(null);
    }
  };

  if (pool.state === "paused") {
    return (
      <section
        className={cx(BANNER, "border-l-danger")}
        role="alert"
        aria-labelledby="pool-banner-title"
      >
        <div className={INNER}>
          <div className={TEXT}>
            <h2
              id="pool-banner-title"
              className="font-serif text-[1.2rem] font-semibold text-danger"
            >
              All conversion is paused: the disk is almost full
            </h2>
            <p>
              Free some space on the drive that holds the app&apos;s data. Resume carries on from
              the last saved part of each chapter.
            </p>
            {failure && <p className="text-danger">{failure}</p>}
          </div>
          <Button onClick={() => resume(ALL)} disabled={resuming !== null}>
            {resuming === ALL ? "Resuming…" : "Resume all"}
          </Button>
        </div>
      </section>
    );
  }

  const paused = pool.services.filter((service) => service.state === "paused");
  const silent = pool.services.filter(
    (service) => service.state !== "paused" && !service.reachable,
  );
  if (!pool.held && paused.length === 0 && silent.length === 0) return null;

  // A paused or silent service stays in view during the speed test: it does not end with the test.
  return (
    <>
      {pool.held && (
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
      )}
      {paused.map((service) => (
        <section
          key={service.id}
          className={cx(BANNER, "border-l-danger")}
          role="alert"
          aria-labelledby={`pool-banner-${service.id}`}
        >
          <div className={INNER}>
            <div className={TEXT}>
              <h2
                id={`pool-banner-${service.id}`}
                className="font-serif text-[1.2rem] font-semibold text-danger"
              >
                Conversion with the speech service “{service.id}” is paused
              </h2>
              <p>
                Three of its chapters in a row failed, so it starts no new chapters. Books read by
                other speech services carry on. Resume tries the waiting chapters again; chapters
                that already failed stay failed. (Pausing a single book is done on its page.)
              </p>
              {service.error && (
                <p className="text-ink-muted wrap-anywhere">
                  Last error: <q>{service.error}</q> Look at the app&apos;s logs for the details.
                </p>
              )}
              {failure && resuming === null && <p className="text-danger">{failure}</p>}
            </div>
            <Button onClick={() => resume(service.id)} disabled={resuming !== null}>
              {resuming === service.id ? "Resuming…" : "Resume"}
            </Button>
          </div>
        </section>
      ))}
      {silent.length > 0 && (
        <section className={cx(BANNER, "border-l-accent")} role="status">
          <div className={INNER}>
            <p className={TEXT}>
              <strong>
                {silent.length === 1
                  ? `The speech service “${silent[0]?.id}” does not answer.`
                  : `The speech services ${silent.map((s) => `“${s.id}”`).join(", ")} do not answer.`}
              </strong>{" "}
              Books it reads wait and carry on by themselves once it is back.
            </p>
          </div>
        </section>
      )}
    </>
  );
}
