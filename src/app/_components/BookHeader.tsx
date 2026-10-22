import type { ReactNode } from "react";
import { languageName } from "../_lib/format";
import { BookCover } from "./BookCover";

interface Props {
  id: string;
  title: string;
  author: string | null;
  hasCover: boolean;
  language?: string;
  children?: ReactNode;
}

/** Cover, title and author shared by the preview and the book page. */
export function BookHeader({ id, title, author, hasCover, language, children }: Props) {
  return (
    <header className="flex items-start gap-6">
      <BookCover id={id} title={title} hasCover={hasCover} size="large" />
      <div className="grid min-w-0 flex-1 gap-1">
        <h1 className="font-serif text-[length:clamp(1.5rem,6vw,2.25rem)] leading-[1.15] font-semibold text-balance wrap-anywhere">
          {title}
        </h1>
        <p className="text-[1.05rem] text-ink-muted wrap-anywhere">{author ?? "Unknown author"}</p>
        {language && (
          <p className="text-[0.85rem] text-ink-muted wrap-anywhere">{languageName(language)}</p>
        )}
        {children}
      </div>
    </header>
  );
}
