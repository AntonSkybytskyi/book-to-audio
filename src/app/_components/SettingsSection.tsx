import type { ReactNode } from "react";

interface Props {
  /** The id of the title, for `aria-labelledby` inside the section too. */
  titleId: string;
  title: string;
  children: ReactNode;
}

/** One titled section of the settings page. */
export function SettingsSection({ titleId, title, children }: Props) {
  return (
    <section className="mt-8 grid gap-[0.9rem] border-t border-rule pt-5" aria-labelledby={titleId}>
      <h2
        id={titleId}
        className="text-[0.8rem] font-semibold tracking-[0.08em] text-ink-muted uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
