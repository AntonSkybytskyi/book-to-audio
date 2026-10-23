"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/ui/shared/api/request";
import { cancelBenchmark, startBenchmark, type BenchmarkInfo } from "@/ui/entities/benchmark/api";
import {
  benchmarkBusy,
  benchmarkStatusLine,
  formatNovel,
  loadNote,
  formatRate,
  formatRtf,
  realTimeSpeed,
  workersHint,
} from "@/ui/entities/benchmark/benchmark";
import { cx } from "@/ui/shared/lib/cx";
import { languageName } from "@/ui/entities/language/language-names";
import { pluralize } from "@/ui/shared/lib/format";
import { useBenchmark } from "@/ui/entities/benchmark/use-benchmark";
import { Button } from "@/ui/shared/ui/Button";
import { ProgressBar } from "@/ui/shared/ui/ProgressBar";
import { SettingsSection } from "./SettingsSection";

const HELP = "max-w-[38rem] text-ink-muted";
const LIVE = "text-[0.9rem] text-ink-muted";

// On a narrow screen each voice becomes a small card, so nothing needs sideways scrolling.
const CELL =
  "border-t border-rule px-2 py-[0.6rem] text-left align-top max-sm:block max-sm:border-0 max-sm:px-0 max-sm:py-[0.15rem]";
const HEAD_CELL =
  "border-b border-rule px-2 py-[0.6rem] text-left align-top text-[0.8rem] font-semibold text-ink-muted max-sm:block";
/** A measured value: on a narrow screen its column name goes before it, on the same line. */
const VALUE_CELL =
  "border-t border-rule px-2 py-[0.6rem] text-left align-top max-sm:flex max-sm:justify-between max-sm:gap-4 max-sm:border-0 max-sm:px-0 max-sm:py-[0.15rem] max-sm:before:text-ink-muted max-sm:before:content-[attr(data-label)] max-sm:*:text-right";

const measuredAt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The speed test: how fast each voice reads, and the button to measure again. `workers` stands for
 * the worker counts in use; the results are asked for again when it changes.
 */
export function SpeedSection({ workers }: { workers: string }) {
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
      <SettingsSection titleId="speed-title" title="Speed test">
        <p className={LIVE} role={error ? "alert" : "status"}>
          {error ? error.message : "Loading the speed test…"}
        </p>
      </SettingsSection>
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
    <SettingsSection titleId="speed-title" title="Speed test">
      <p className={HELP}>
        A short text is read aloud in each language to see how fast this computer is. The app uses
        it for the times on the preview and the book page, and keeps adjusting them as books are
        converted. The test takes a few minutes and pauses conversion while it runs.
      </p>

      {info.rows.length === 0 ? (
        <p className={LIVE}>No speech service has a voice yet, so there is nothing to measure.</p>
      ) : (
        <>
          <p className={LIVE} id="speed-table-note">
            Speed of each voice,{" "}
            {info.services.length === 1
              ? `with ${pluralize(info.services[0]?.workers ?? 1, "worker")}`
              : "with the workers of its speech service"}
          </p>
          <table
            className="w-full border-collapse tabular-nums max-sm:block"
            aria-describedby="speed-table-note"
          >
            <thead className="max-sm:absolute max-sm:h-px max-sm:w-px max-sm:overflow-hidden max-sm:[clip-path:inset(50%)]">
              <tr className="max-sm:block">
                <th scope="col" className={HEAD_CELL}>
                  Voice
                </th>
                <th scope="col" className={HEAD_CELL}>
                  Audio per 1,000 characters
                </th>
                <th scope="col" className={HEAD_CELL}>
                  Real-time factor
                </th>
                <th scope="col" className={HEAD_CELL}>
                  90,000-word novel
                </th>
              </tr>
            </thead>
            <tbody className="max-sm:block">
              {info.rows.map(({ language, voiceId, result }) => (
                <tr
                  key={voiceId}
                  className="max-sm:block max-sm:border-t max-sm:border-rule max-sm:py-2"
                >
                  <th scope="row" className={cx(CELL, "font-normal")}>
                    <span className="block font-serif text-[1.05rem]">
                      {languageName(language)}
                    </span>
                    <span className="block text-[0.78rem] text-ink-muted wrap-anywhere">
                      {voiceId}
                    </span>
                  </th>
                  {result ? (
                    <>
                      <td data-label="Audio per 1,000 characters" className={VALUE_CELL}>
                        <span>{formatRate(result.secondsPerKChar)}</span>
                      </td>
                      <td data-label="Real-time factor" className={VALUE_CELL}>
                        <span>
                          {formatRtf(result.rtf)}
                          <span className="block text-[0.8rem] text-ink-muted max-sm:ml-2 max-sm:inline">
                            {realTimeSpeed(result.rtf)}
                          </span>
                        </span>
                      </td>
                      <td data-label="90,000-word novel" className={VALUE_CELL}>
                        <span>{formatNovel(result)}</span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className={cx(CELL, "text-ink-muted italic")}>
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
        <p className={LIVE}>
          Measured {measuredAt(latest)} on {info.machine.cpuModel} with {info.machine.cpuCount}{" "}
          cores.
          {outdated && " That was another computer, or the text rules changed since: run it again."}
        </p>
      )}
      {newest && loadNote(newest, info.machine.cpuCount) && (
        <p className={LIVE}>{loadNote(newest, info.machine.cpuCount)}</p>
      )}
      {!latest && !busy && missing && info.rows.length > 0 && (
        <p className={LIVE}>Until the test has run, estimates are rough guesses and say so.</p>
      )}
      {results.length > 0 &&
        info.services.flatMap((service) => {
          const hint = workersHint(service, info.services.length > 1);
          return hint
            ? [
                <p key={service.id} className={LIVE}>
                  {hint}
                </p>,
              ]
            : [];
        })}

      {busy && info.state !== "waiting" && (
        <ProgressBar
          value={info.progress}
          label="Speed test progress"
          busy={info.state === "cancelling"}
        />
      )}
      <div className="flex flex-wrap gap-3">
        {/* aria-disabled, not disabled: a disabled button drops the keyboard focus. */}
        <Button
          ref={runButton}
          aria-disabled={asking || busy}
          onClick={() => {
            if (!asking && !busy) void act(startBenchmark);
          }}
        >
          {busy ? "Speed test running" : "Run benchmark"}
        </Button>
        {busy && (
          <Button
            variant="outline"
            aria-disabled={asking || info.state === "cancelling"}
            onClick={async () => {
              if (asking || info.state === "cancelling") return;
              await act(cancelBenchmark);
              // The Cancel button is gone now; the keyboard goes back to the button that started it.
              runButton.current?.focus();
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      <p className="min-h-[1.6em] text-[0.9rem]" role="status" aria-live="polite">
        {failure ? <span className="text-danger">{failure}</span> : statusLine}
      </p>
    </SettingsSection>
  );
}
