import type { Language, SettingsView } from "@book-to-audio/contracts";
import { requestSnapshot, request } from "@/ui/shared/api/request";

export type { SettingsView as Settings } from "@book-to-audio/contracts";

export const getSettings = () => requestSnapshot<SettingsView>("/api/settings");
/** A speech service's worker count; null goes back to the number the service reports. */
export const saveWorkers = (service: string, workers: number | null) =>
  request<SettingsView>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workers: { [service]: workers } }),
  });
export const saveShownLanguages = (shownLanguages: Language[]) =>
  request<SettingsView>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shownLanguages }),
  });
