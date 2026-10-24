"use client";

import { useState } from "react";
import { ApiError } from "@/ui/shared/api/request";
import { saveWorkers, type Settings } from "@/ui/entities/settings/api";
import { servicePool } from "@/ui/entities/pool/pool";
import { usePool } from "@/ui/entities/pool/use-pool";
import { pluralize } from "@/ui/shared/lib/format";
import { Button } from "@/ui/shared/ui/Button";
import { SettingsSection } from "./SettingsSection";

const HELP = "max-w-[38rem] text-ink-muted";
const LIVE = "text-[0.9rem] text-ink-muted";
const STATUS = "min-h-[1.6em] text-[0.9rem]";
const STEP =
  "grid size-11 cursor-pointer place-items-center rounded-full border border-accent bg-transparent text-[1.4rem] leading-none text-accent transition-[background-color,color,opacity] duration-150 ease-[ease] enabled-hover:bg-accent enabled-hover:text-accent-ink disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-muted disabled:opacity-60";

interface Props {
  settings: Settings;
  onSaved: (settings: Settings) => void;
}

/** How many chapters each speech service reads at once: what it reports, or the owner's number. */
export function WorkersSection({ settings, onSaved }: Props) {
  const pool = usePool();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const several = settings.services.length > 1;

  const change = async (service: string, workers: number | null) => {
    setSaving(true);
    setFailure(null);
    setMessage(null);
    try {
      const saved = await saveWorkers(service, workers);
      onSaved(saved);
      const now = saved.services.find((s) => s.id === service)?.workers ?? 0;
      setMessage(
        `Saved: ${pluralize(now, "chapter")} at a time${several ? ` with “${service}”` : ""}.`,
      );
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : "Could not save the setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection titleId="workers-title" title="Conversion speed">
      <p className={HELP}>
        How many chapters are read aloud at the same time
        {several ? ", for each speech service" : ""}. Each service says how many it handles at once;
        more is faster only if the service has the processor and memory for it. Changes apply at
        once: extra workers finish the chapter they are on and then stop.
      </p>

      {settings.services.map((service) => {
        const titleId = `workers-${service.id}`;
        const busy = servicePool(pool, service.id)?.activeWorkers ?? 0;
        return (
          <div key={service.id} className="grid gap-2">
            {several && (
              <h3 id={titleId} className="font-serif text-[1.05rem]">
                {service.id}
              </h3>
            )}
            <div
              className="flex flex-wrap items-center gap-4"
              role="group"
              aria-labelledby={several ? titleId : "workers-title"}
            >
              <button
                type="button"
                className={STEP}
                onClick={() => change(service.id, service.workers - 1)}
                disabled={saving || !service.reachable || service.workers <= 1}
                aria-label="Fewer chapters at a time"
              >
                −
              </button>
              <output
                className="min-w-[2.5ch] text-center font-serif text-[2.5rem] font-semibold tabular-nums"
                aria-live="polite"
                aria-label="Chapters at a time"
              >
                {service.workers}
              </output>
              <button
                type="button"
                className={STEP}
                onClick={() => change(service.id, service.workers + 1)}
                disabled={saving || !service.reachable || service.workers >= settings.maxWorkers}
                aria-label="More chapters at a time"
              >
                +
              </button>
              <p className="text-[0.85rem] leading-[1.4] text-ink-muted">
                {service.reachable ? (
                  <>
                    of up to {settings.maxWorkers}
                    <br />
                    the service handles {service.reported}
                  </>
                ) : (
                  "the service does not answer"
                )}
              </p>
              {service.override !== null && (
                <Button variant="muted" onClick={() => change(service.id, null)} disabled={saving}>
                  Use {service.reported}
                </Button>
              )}
            </div>
            {pool && service.reachable && (
              <p className={LIVE}>
                {busy === 0
                  ? "No chapter is being read right now."
                  : `Reading ${pluralize(busy, "chapter")} right now.`}
              </p>
            )}
          </div>
        );
      })}

      <p className={STATUS} role="status">
        {failure ? <span className="text-danger">{failure}</span> : message}
      </p>
    </SettingsSection>
  );
}
