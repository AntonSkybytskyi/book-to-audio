import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex max-w-column items-baseline justify-between px-gutter py-4">
        <a
          className="absolute -left-[999px] rounded-base bg-accent px-3 py-2 text-accent-ink focus:top-2 focus:left-gutter focus:z-10"
          href="#main"
        >
          Skip to content
        </a>
        <Link
          href="/"
          className="font-serif text-[1.25rem] tracking-[0.01em] text-ink italic no-underline hover:text-accent"
        >
          book-to-audio
        </Link>
        <nav aria-label="Main">
          <Link
            href="/settings"
            className="text-[0.95rem] text-ink-muted no-underline hover:text-accent hover:underline"
          >
            Settings
          </Link>
        </nav>
      </div>
    </header>
  );
}
