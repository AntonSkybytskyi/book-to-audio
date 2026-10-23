import { BookList } from "@/ui/features/library/BookList";
import { Page } from "@/ui/shared/ui/Page";
import { UploadZone } from "@/ui/features/library/UploadZone";

export default function HomePage() {
  return (
    <Page>
      <h1 className="font-serif text-[length:clamp(1.6rem,5vw,2.1rem)] leading-[1.2] font-semibold text-balance">
        Books you can listen to
      </h1>
      <p className="mt-2 max-w-[34rem] text-ink-muted">
        Turn your own e-books into audiobooks. Everything is read aloud on this computer.
      </p>
      <UploadZone />
      <BookList />
    </Page>
  );
}
