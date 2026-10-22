"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  getSettings,
  saveShownLanguages,
  saveWorkers,
  type Language,
  type Settings,
} from "../_lib/api";
import { languageName, pluralize } from "../_lib/format";
import { ALL_LANGUAGES, languageSettingsMessage } from "../_lib/language-picker";
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
  const [languageStatus, setLanguageStatus] = useState<{ text: string; failed: boolean } | null>(
    null,
  );

  if (!settings) return <LoadState error={error} />;

  // Not disabled while saving: a disabled checkbox would drop the keyboard focus.
  const toggleLanguage = async (code: Language, shown: boolean) => {
    if (saving) return;
    const next = ALL_LANGUAGES.filter((c) =>
      c === code ? shown : settings.shownLanguages.includes(c),
    );
    setSaving(true);
    setLanguageStatus(null);
    try {
      const saved = await saveShownLanguages(next);
      setData(saved);
      setLanguageStatus({ text: languageSettingsMessage(saved.shownLanguages), failed: false });
    } catch (caught) {
      const text = caught instanceof ApiError ? caught.message : "Could not save the setting.";
      setLanguageStatus({ text, failed: true });
    } finally {
      setSaving(false);
    }
  };

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

      <section className={styles.section} aria-labelledby="languages-title">
        <h2 id="languages-title" className={styles.sectionTitle}>
          Languages
        </h2>
        <p className={styles.help}>
          Which languages the language list offers when you convert a book. This only shortens the
          list: a book in a hidden language, such as one the app detects as Russian, is still
          selected for it and can be converted.
        </p>

        <fieldset className={styles.languages} aria-busy={saving}>
          <legend className={styles.legend}>Show in the language list</legend>
          {ALL_LANGUAGES.map((code) => {
            const shown = settings.shownLanguages.includes(code);
            const onlyOne = shown && settings.shownLanguages.length === 1;
            return (
              <label key={code} className={styles.language} data-disabled={onlyOne || undefined}>
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={shown}
                  disabled={onlyOne}
                  aria-describedby={onlyOne ? "languages-last" : undefined}
                  onChange={(event) => toggleLanguage(code, event.target.checked)}
                />
                <span className={styles.languageName}>{languageName(code)}</span>
                <span className={styles.languageState}>{shown ? "shown" : "hidden"}</span>
              </label>
            );
          })}
        </fieldset>
        {settings.shownLanguages.length === 1 && (
          <p id="languages-last" className={styles.live}>
            At least one language has to stay shown.
          </p>
        )}

        <p className={styles.status} role="status">
          {languageStatus?.failed ? (
            <span className={shared.error}>{languageStatus.text}</span>
          ) : (
            languageStatus?.text
          )}
        </p>
      </section>
    </div>
  );
}
