"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, cancelBenchmark, startBenchmark, type BenchmarkInfo } from "../_lib/api";
import {
  benchmarkBusy,
  benchmarkStatusLine,
  formatNovel,
  loadNote,
  formatRate,
  formatRtf,
  realTimeSpeed,
  workersHint,
} from "../_lib/benchmark";
import { languageName, pluralize } from "../_lib/format";
import { useBenchmark } from "../_lib/use-benchmark";
import { ProgressBar } from "./ProgressBar";
import styles from "./SettingsView.module.css";
import speed from "./SpeedSection.module.css";
import shared from "./shared.module.css";

const measuredAt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The speed test: how fast each voice reads on this computer, and the button to measure again. */
export function SpeedSection({ workers }: { workers: number }) {
  const { data: info, error, setData, refresh } = useBenchmark();
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const runButton = useRef<HTMLButtonElement>(null);

  // The novel's conversion time depends on the number of workers: ask again when it changes.
  const lastWorkers = useRef(workers);
  useEffect(() => {
    if (lastWorkers.current === workers) return;
    lastWorkers.current = workers;
    refresh();
  }, [workers, refresh]);

  if (!info) {
    return (
      <section className={styles.section} aria-labelledby="speed-title">
        <h2 id="speed-title" className={styles.sectionTitle}>
          Speed test
        </h2>
        <p className={styles.live} role={error ? "alert" : "status"}>
          {error ? error.message : "Loading the speed test…"}
        </p>
      </section>
    );
  }

  const busy = benchmarkBusy(info);
  const results = info.rows.flatMap((row) => (row.result ? [row.result] : []));
  const latest = results
    .map((r) => r.measuredAt)
    .toSorted()
    .at(-1);
  const outdated = results.some((r) => r.outdated);
  const newest = results.toSorted((a, b) => a.measuredAt.localeCompare(b.measuredAt)).at(-1);
  const missing = info.rows.some((row) => !row.result);

  const act = async (action: () => Promise<BenchmarkInfo>) => {
    setAsking(true);
    setFailure(null);
    try {
      setData(await action());
    } catch (caught) {
      // A second click while a test runs is refused with a 409; the page shows the running test anyway.
      if (caught instanceof ApiError && caught.status === 409) refresh();
      else setFailure(caught instanceof ApiError ? caught.message : "Could not reach the server.");
    } finally {
      setAsking(false);
    }
  };

  const statusLine = benchmarkStatusLine(info);

  return (
    <section className={styles.section} aria-labelledby="speed-title">
      <h2 id="speed-title" className={styles.sectionTitle}>
        Speed test
      </h2>
      <p className={styles.help}>
        A short text is read aloud in each language to see how fast this computer is. The app uses
        it for the times on the preview and the book page, and keeps adjusting them as books are
        converted. The test takes a few minutes and pauses conversion while it runs.
      </p>

      {info.rows.length === 0 ? (
        <p className={styles.live}>No voice is installed, so there is nothing to measure.</p>
      ) : (
        <>
          <p className={styles.live} id="speed-table-note">
            Speed of each voice, with {pluralize(info.workers, "worker")}
          </p>
          <table className={speed.table} aria-describedby="speed-table-note">
            <thead>
              <tr>
                <th scope="col">Voice</th>
                <th scope="col">Audio per 1,000 characters</th>
                <th scope="col">Real-time factor</th>
                <th scope="col">90,000-word novel</th>
              </tr>
            </thead>
            <tbody>
              {info.rows.map(({ language, voiceId, result }) => (
                <tr key={voiceId}>
                  <th scope="row" className={speed.voice}>
                    <span className={speed.language}>{languageName(language)}</span>
                    <span className={speed.voiceId}>{voiceId}</span>
                  </th>
                  {result ? (
                    <>
                      <td data-label="Audio per 1,000 characters">
                        <span>{formatRate(result.secondsPerKChar)}</span>
                      </td>
                      <td data-label="Real-time factor">
                        <span>
                          {formatRtf(result.rtf)}
                          <span className={speed.sub}>{realTimeSpeed(result.rtf)}</span>
                        </span>
                      </td>
                      <td data-label="90,000-word novel">
                        <span>{formatNovel(result)}</span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className={speed.none}>
                      Not measured yet
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {latest && (
        <p className={styles.live}>
          Measured {measuredAt(latest)} on {info.machine.cpuModel} with {info.machine.cpuCount}{" "}
          cores.
          {outdated && " That was another computer, or the text rules changed since: run it again."}
        </p>
      )}
      {newest && loadNote(newest, info.machine.cpuCount) && (
        <p className={styles.live}>{loadNote(newest, info.machine.cpuCount)}</p>
      )}
      {!latest && !busy && missing && info.rows.length > 0 && (
        <p className={styles.live}>
          Until the test has run, estimates are rough guesses and say so.
        </p>
      )}
      {results.length > 0 && workersHint(info) && (
        <p className={styles.live}>{workersHint(info)}</p>
      )}

      {busy && info.state !== "waiting" && (
        <ProgressBar
          value={info.progress}
          label="Speed test progress"
          busy={info.state === "cancelling"}
        />
      )}
      <div className={speed.actions}>
        {/* aria-disabled, not disabled: a disabled button drops the keyboard focus. */}
        <button
          ref={runButton}
          type="button"
          className={shared.button}
          aria-disabled={asking || busy}
          onClick={() => {
            if (!asking && !busy) void act(startBenchmark);
          }}
        >
          {busy ? "Speed test running" : "Run benchmark"}
        </button>
        {busy && (
          <button
            type="button"
            className={`${shared.button} ${shared.outline}`}
            aria-disabled={asking || info.state === "cancelling"}
            onClick={async () => {
              if (asking || info.state === "cancelling") return;
              await act(cancelBenchmark);
              // The Cancel button is gone now; the keyboard goes back to the button that started it.
              runButton.current?.focus();
            }}
          >
            Cancel
          </button>
        )}
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {failure ? <span className={shared.error}>{failure}</span> : statusLine}
      </p>
    </section>
  );
}
