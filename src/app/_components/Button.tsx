import Link from "next/link";
import type { ComponentProps } from "react";
import { cx } from "../_lib/cx";

// Tailwind finds classes by scanning the source for whole names, so every class is written out in full.
const BASE =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-base border font-semibold no-underline transition-[background-color,color] duration-150 ease-[ease] disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const SIZES = {
  normal: "min-h-11 px-5 py-2",
  small: "min-h-9 px-[0.85rem] py-1 text-[0.875rem]",
  /** Small text in a taller box: a failed chapter's retry, which is what its row is waiting for. */
  smallTall: "min-h-10 px-[0.85rem] py-1 text-[0.875rem]",
};

// Each variant has all of its colors, so no two classes of one button set the same property:
// which of two such classes wins depends on Tailwind's order in the stylesheet, not on the class list.
const VARIANTS = {
  primary:
    "border-accent bg-accent text-accent-ink enabled-hover:bg-transparent enabled-hover:text-accent disabled:opacity-50 aria-disabled:opacity-50",
  outline:
    "border-accent bg-transparent text-accent enabled-hover:bg-accent-soft disabled:opacity-50 aria-disabled:opacity-50",
  /** Destructive: red, so it is never mistaken for the safe choice. */
  danger:
    "border-danger bg-danger text-paper enabled-hover:bg-transparent enabled-hover:text-danger disabled:opacity-50 aria-disabled:opacity-50",
  /** A destructive action beside content, quiet until it is pointed at. */
  outlineDanger:
    "border-rule bg-transparent text-danger enabled-hover:border-danger disabled:opacity-50 aria-disabled:opacity-50",
  /** A secondary action in a list row. */
  muted:
    "border-rule bg-transparent text-ink-muted enabled-hover:border-accent enabled-hover:bg-accent-soft enabled-hover:text-accent disabled:opacity-50 aria-disabled:opacity-50",
  /** A file that is not there yet: no fill, dashed edge and muted text, so it never reads as a pressed or loading button. */
  unavailable: "border-dashed border-rule bg-transparent text-ink-muted disabled:opacity-85",
};

interface Look {
  size?: keyof typeof SIZES;
  variant?: keyof typeof VARIANTS;
  /** Placement only (margins, alignment): the look comes from `size` and `variant`. */
  className?: string;
}

type Props =
  | (Look & ComponentProps<"button"> & { href?: undefined })
  | (Look & ComponentProps<typeof Link>);

/** A button, or a link that looks like one when it has an `href`. */
export function Button({ size = "normal", variant = "primary", className, ...props }: Props) {
  const classes = cx(BASE, SIZES[size], VARIANTS[variant], className);
  if (props.href !== undefined) return <Link {...props} className={classes} />;
  return <button type="button" {...props} className={classes} />;
}
