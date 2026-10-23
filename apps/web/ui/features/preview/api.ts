import type { BookEstimate } from "@/ui/entities/book/api";
import type { Language } from "@/ui/entities/language/api";
import type { SpeedModel } from "@book-to-audio/contracts";
import { request } from "@/ui/shared/api/request";

/** The estimate of an unconverted book as if it were read in another language. */
export interface LanguageEstimate {
  estimate: BookEstimate | null;
  speed: SpeedModel | null;
  chapterSeconds: number[];
  /** The book's own text is not counted yet. */
  measuring: boolean;
}

export const getLanguageEstimate = (id: string, language: Language) =>
  request<LanguageEstimate>(`/api/books/${id}/estimate?language=${language}`);
