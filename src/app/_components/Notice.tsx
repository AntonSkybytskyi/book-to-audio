import type { ReactNode } from "react";

interface Props {
  title: string;
  /** h1 when the notice is the whole page, h2 inside one. */
  level?: 1 | 2;
  role?: "alert";
  /** Paragraphs under the title. */
  children: ReactNode;
}

/** A short message in place of content: an empty shelf, a missing or deleted book. */
export function Notice({ title, level = 2, role, children }: Props) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="my-12 max-w-[30rem] [&>p]:mt-2 [&>p]:text-ink-muted" role={role}>
      <Heading className="font-serif text-[1.4rem]">{title}</Heading>
      {children}
    </div>
  );
}
