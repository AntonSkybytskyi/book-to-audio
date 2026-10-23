import type { Language } from "@/ui/entities/language/api";
import { requestSnapshot, request } from "@/ui/shared/api/request";

export interface Settings {
  workers: number;
  maxWorkers: number;
  defaultWorkers: number;
  /** The languages the language picker offers. */
  shownLanguages: Language[];
}

export const getSettings = () => requestSnapshot<Settings>("/api/settings");
export const saveWorkers = (workers: number) =>
  request<Settings>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workers }),
  });
export const saveShownLanguages = (shownLanguages: Language[]) =>
  request<Settings>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shownLanguages }),
  });
