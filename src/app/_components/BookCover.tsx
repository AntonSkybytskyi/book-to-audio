import { coverUrl } from "../_lib/api";
import { cx } from "../_lib/cx";

interface Props {
  id: string;
  title: string;
  hasCover: boolean;
  size: "small" | "large";
}

/** The cover image, or a plain typographic stand-in when the book has none. */
export function BookCover({ id, title, hasCover, size }: Props) {
  const large = size === "large";
  return (
    <div
      className={cx(
        "aspect-[2/3] flex-none overflow-hidden rounded-[2px] bg-accent-soft shadow-[0_1px_0_var(--color-rule),2px_3px_8px_rgb(0_0_0/0.18)]",
        large ? "w-[min(9rem,34vw)]" : "w-13",
      )}
    >
      {hasCover ? (
        // eslint-disable-next-line @next/next/no-img-element -- served by our API, sized by CSS
        <img src={coverUrl(id)} alt="" className="block size-full object-cover" loading="lazy" />
      ) : (
        <span
          className={cx(
            "grid size-full place-items-center font-serif text-accent",
            large ? "text-[3.5rem]" : "text-[1.6rem]",
          )}
          aria-hidden="true"
        >
          {title.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
    </div>
  );
}
