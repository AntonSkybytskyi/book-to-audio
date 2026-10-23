import type { Language, SettingsView } from "@book-to-audio/contracts";
import { requestSnapshot, request } from "@/ui/shared/api/request";

export type { SettingsView as Settings } from "@book-to-audio/contracts";

export const getSettings = () => requestSnapshot<SettingsView>("/api/settings");
export const saveWorkers = (workers: number) =>
  request<SettingsView>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workers }),
  });
export const saveShownLanguages = (shownLanguages: Language[]) =>
  request<SettingsView>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shownLanguages }),
  });
