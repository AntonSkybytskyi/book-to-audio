"use client";

import { useState } from "react";
import { ApiError } from "@/ui/shared/api/request";
import { saveVoice, type Settings } from "@/ui/entities/settings/api";
import { languageName } from "@/ui/entities/language/language-names";
import { SettingsSection } from "./SettingsSection";

const HELP = "max-w-[38rem] text-ink-muted";
const LIVE = "text-[0.9rem] text-ink-muted";
const STATUS = "min-h-[1.6em] text-[0.9rem]";
const SELECT =
  "min-h-11 w-full max-w-[28rem] rounded-base border border-rule bg-paper-raised px-3 font-serif text-[1rem] text-ink focus-visible:border-accent";
/** The value of the option that goes back to the default voice. */
const DEFAULT = "";

interface Props {
  settings: Settings;
  onSaved: (settings: Settings) => void;
}

/** Which voice reads each language, from any speech service. */
export function VoicesSection({ settings, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const several = settings.services.length > 1;

  if (settings.voices.length === 0) {
    return (
      <SettingsSection titleId="voices-title" title="Voices">
        <p className={LIVE}>No speech service has a voice yet.</p>
      </SettingsSection>
    );
  }

  const change = async (language: Settings["voices"][number]["language"], value: string) => {
    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveVoice(language, value === DEFAULT ? null : value);
      onSaved(saved);
      const now = saved.voices.find((v) => v.language === language)?.voice;
      setStatus({
        text: `Saved: ${languageName(language)} is read by ${now ?? "no voice yet"}.`,
        failed: false,
      });
    } catch (caught) {
      setStatus({
        text: caught instanceof ApiError ? caught.message : "Could not save the setting.",
        failed: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection titleId="voices-title" title="Voices">
      <p className={HELP}>
        The voice each language is read by. The default is the first voice for the language
        {several ? ", speech services in the order they are set up" : ""}. A new voice applies from
        the next chapter on: chapters already read keep their voice, so a book that is being
        converted can end up with two.
      </p>

      {settings.voices.map(({ language, voice, chosen, options }) => {
        const id = `voice-${language}`;
        const fallback = options[0];
        const missing = chosen !== null && !options.some((o) => o.id === chosen);
        return (
          <div key={language} className="grid gap-1">
            <label htmlFor={id} className="font-serif text-[1.05rem]">
              {languageName(language)}
            </label>
            <select
              id={id}
              className={SELECT}
              value={chosen ?? DEFAULT}
              aria-busy={saving}
              onChange={(event) => {
                if (!saving) void change(language, event.target.value);
              }}
            >
              <option value={DEFAULT}>Default{fallback ? ` (${fallback.name})` : ""}</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {several ? ` · ${option.service}` : ""}
                </option>
              ))}
              {missing && <option value={chosen}>{chosen} (not available now)</option>}
            </select>
            {voice === null && (
              <p className={LIVE}>
                Its speech service has not answered yet; books in this language wait for it.
              </p>
            )}
          </div>
        );
      })}

      <p className={STATUS} role="status">
        {status?.failed ? <span className="text-danger">{status.text}</span> : status?.text}
      </p>
    </SettingsSection>
  );
}
