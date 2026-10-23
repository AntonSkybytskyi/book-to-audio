"use client";

import { useCallback, useState } from "react";
import { ApiError } from "@/ui/shared/api/request";
import {
  getSettings,
  saveShownLanguages,
  saveWorkers,
  type Settings,
} from "@/ui/entities/settings/api";
import { type Language } from "@/ui/entities/language/api";
import { languageName } from "@/ui/entities/language/language-names";
import { pluralize } from "@/ui/shared/lib/format";
import { ALL_LANGUAGES, languageSettingsMessage } from "@/ui/entities/language/language-picker";
import { usePool } from "@/ui/entities/pool/pool-store";
import { usePoll } from "@/ui/shared/api/use-poll";
import { LoadState } from "@/ui/shared/ui/LoadState";
import { Page } from "@/ui/shared/ui/Page";
import { SettingsSection } from "./SettingsSection";
import { SpeedSection } from "./SpeedSection";

const HELP = "max-w-[38rem] text-ink-muted";
const LIVE = "text-[0.9rem] text-ink-muted";
const STATUS = "min-h-[1.6em] text-[0.9rem]";
const STEP =
  "grid size-11 cursor-pointer place-items-center rounded-full border border-accent bg-transparent text-[1.4rem] leading-none text-accent transition-[background-color,color,opacity] duration-150 ease-[ease] enabled-hover:bg-accent enabled-hover:text-accent-ink disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-muted disabled:opacity-60";

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
    <Page>
      <h1 className="font-serif text-[length:clamp(1.6rem,5vw,2.1rem)] leading-[1.2] font-semibold text-balance">
        Settings
      </h1>

      <SettingsSection titleId="workers-title" title="Conversion speed">
        <p className={HELP}>
          How many chapters are read aloud at the same time. More is faster but uses more of the
          processor and memory, because each one runs its own copy of the speech engine. Changes
          apply at once: extra workers finish the chapter they are on and then stop.
        </p>

        <div className="flex items-center gap-4" role="group" aria-labelledby="workers-title">
          <button
            type="button"
            className={STEP}
            onClick={() => change(settings.workers - 1)}
            disabled={saving || settings.workers <= 1}
            aria-label="Fewer chapters at a time"
          >
            −
          </button>
          <output
            className="min-w-[2.5ch] text-center font-serif text-[2.5rem] font-semibold tabular-nums"
            aria-live="polite"
            aria-label="Chapters at a time"
          >
            {settings.workers}
          </output>
          <button
            type="button"
            className={STEP}
            onClick={() => change(settings.workers + 1)}
            disabled={saving || settings.workers >= settings.maxWorkers}
            aria-label="More chapters at a time"
          >
            +
          </button>
          <p className="text-[0.85rem] leading-[1.4] text-ink-muted">
            of up to {settings.maxWorkers}
            <br />
            default {settings.defaultWorkers}
          </p>
        </div>

        <p className={STATUS} role="status">
          {failure ? <span className="text-danger">{failure}</span> : message}
        </p>
        {pool && (
          <p className={LIVE}>
            {pool.state === "paused"
              ? "Conversion is paused. Resume it from the banner at the top."
              : pool.activeWorkers === 0
                ? "No chapter is being read right now."
                : `Reading ${pluralize(pool.activeWorkers, "chapter")} right now.`}
          </p>
        )}
      </SettingsSection>

      <SpeedSection workers={settings.workers} />

      <SettingsSection titleId="languages-title" title="Languages">
        <p className={HELP}>
          Which languages the language list offers when you convert a book. This only shortens the
          list: a book in a hidden language, such as one the app detects as Russian, is still
          selected for it and can be converted.
        </p>

        <fieldset className="grid max-w-[24rem] gap-1" aria-busy={saving}>
          <legend className="mb-[0.4rem] font-semibold">Show in the language list</legend>
          {ALL_LANGUAGES.map((code) => {
            const shown = settings.shownLanguages.includes(code);
            const onlyOne = shown && settings.shownLanguages.length === 1;
            return (
              <label
                key={code}
                className="grid min-h-11 cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 rounded-base border border-rule bg-paper-raised px-3 transition-[border-color] duration-150 ease-[ease] hover:not-data-disabled:border-accent data-disabled:cursor-not-allowed"
                data-disabled={onlyOne || undefined}
              >
                <input
                  type="checkbox"
                  // The browser's own checkbox margin, which preflight removes.
                  className="m-[3px_3px_3px_4px] size-[1.15rem] accent-accent"
                  checked={shown}
                  disabled={onlyOne}
                  aria-describedby={onlyOne ? "languages-last" : undefined}
                  onChange={(event) => toggleLanguage(code, event.target.checked)}
                />
                <span className="font-serif text-[1.05rem]">{languageName(code)}</span>
                <span className="text-[0.8rem] tracking-[0.06em] text-ink-muted uppercase">
                  {shown ? "shown" : "hidden"}
                </span>
              </label>
            );
          })}
        </fieldset>
        {settings.shownLanguages.length === 1 && (
          <p id="languages-last" className={LIVE}>
            At least one language has to stay shown.
          </p>
        )}

        <p className={STATUS} role="status">
          {languageStatus?.failed ? (
            <span className="text-danger">{languageStatus.text}</span>
          ) : (
            languageStatus?.text
          )}
        </p>
      </SettingsSection>
    </Page>
  );
}
