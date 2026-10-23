import type { ReactNode } from "react";

/** The centred column every page's content sits in. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-column px-gutter pt-8 pb-20">{children}</div>;
}
