"use client";

import { useCallback, useState } from "react";
import { ApiError } from "@/ui/shared/api/request";
import { getSettings, saveShownLanguages, type Settings } from "@/ui/entities/settings/api";
import { type Language } from "@/ui/entities/language/api";
import { languageName } from "@/ui/entities/language/language-names";
import { ALL_LANGUAGES, languageSettingsMessage } from "@/ui/entities/language/language-picker";
import { useLiveQuery } from "@/ui/shared/api/use-live-query";
import { LoadState } from "@/ui/shared/ui/LoadState";
import { Page } from "@/ui/shared/ui/Page";
import { SettingsSection } from "./SettingsSection";
import { SpeedSection } from "./SpeedSection";
import { WorkersSection } from "./WorkersSection";

const HELP = "max-w-[38rem] text-ink-muted";
const LIVE = "text-[0.9rem] text-ink-muted";
const STATUS = "min-h-[1.6em] text-[0.9rem]";

const never = () => false;

export function SettingsView() {
  const load = useCallback(() => getSettings(), []);
  const {
    data: settings,
    error,
    setData,
  } = useLiveQuery<Settings>({ key: ["settings"], load, keepPolling: never, intervalMs: 5000 });
  const [saving, setSaving] = useState(false);
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

  return (
    <Page>
      <h1 className="font-serif text-[length:clamp(1.6rem,5vw,2.1rem)] leading-[1.2] font-semibold text-balance">
        Settings
      </h1>

      <WorkersSection settings={settings} onSaved={setData} />

      <SpeedSection
        workers={settings.services.map((service) => `${service.id}=${service.workers}`).join(",")}
      />

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
