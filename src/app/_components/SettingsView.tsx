"use client";

import { useCallback, useState } from "react";
import { ApiError, getSettings, saveWorkers, type Settings } from "../_lib/api";
import { pluralize } from "../_lib/format";
import { usePool } from "../_lib/pool-store";
import { usePoll } from "../_lib/use-poll";
import { LoadState } from "./LoadState";
import styles from "./SettingsView.module.css";
import shared from "./shared.module.css";

const never = () => false;

export function SettingsView() {
  const load = useCallback(() => getSettings(), []);
  const {
    data: settings,
    error,
    setData,
  } = usePoll<Settings>({ load, keepPolling: never, intervalMs: 5000 });
  const pool = usePool();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!settings) return <LoadState error={error} />;

  const change = async (workers: number) => {
    setSaving(true);
    setFailure(null);
    setMessage(null);
    try {
      const saved = await saveWorkers(workers);
      setData(saved);
      setMessage(`Saved: ${pluralize(saved.workers, "chapter")} at a time.`);
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : "Could not save the setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={shared.page}>
      <h1 className={shared.heading}>Settings</h1>

      <section className={styles.section} aria-labelledby="workers-title">
        <h2 id="workers-title" className={styles.sectionTitle}>
          Conversion speed
        </h2>
        <p className={styles.help}>
          How many chapters are read aloud at the same time. More is faster but uses more of the
          processor and memory, because each one runs its own copy of the speech engine. Changes
          apply at once: extra workers finish the chapter they are on and then stop.
        </p>

        <div className={styles.control} role="group" aria-labelledby="workers-title">
          <button
            type="button"
            className={styles.step}
            onClick={() => change(settings.workers - 1)}
            disabled={saving || settings.workers <= 1}
            aria-label="Fewer chapters at a time"
          >
            −
          </button>
          <output className={styles.value} aria-live="polite" aria-label="Chapters at a time">
            {settings.workers}
          </output>
          <button
            type="button"
            className={styles.step}
            onClick={() => change(settings.workers + 1)}
            disabled={saving || settings.workers >= settings.maxWorkers}
            aria-label="More chapters at a time"
          >
            +
          </button>
          <p className={styles.range}>
            of up to {settings.maxWorkers}
            <br />
            default {settings.defaultWorkers}
          </p>
        </div>

        <p className={styles.status} role="status">
          {failure ? <span className={shared.error}>{failure}</span> : message}
        </p>
        {pool && (
          <p className={styles.live}>
            {pool.state === "paused"
              ? "Conversion is paused. Resume it from the banner at the top."
              : pool.activeWorkers === 0
                ? "No chapter is being read right now."
                : `Reading ${pluralize(pool.activeWorkers, "chapter")} right now.`}
          </p>
        )}
      </section>
    </div>
  );
}
