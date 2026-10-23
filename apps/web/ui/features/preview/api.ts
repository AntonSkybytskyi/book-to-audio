import type { Language, LanguageEstimateView } from "@book-to-audio/contracts";
import { request } from "@/ui/shared/api/request";

export type { LanguageEstimateView as LanguageEstimate };

export const getLanguageEstimate = (id: string, language: Language) =>
  request<LanguageEstimateView>(`/api/books/${id}/estimate?language=${language}`);
