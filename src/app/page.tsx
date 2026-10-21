import { BookList } from "./_components/BookList";
import { UploadZone } from "./_components/UploadZone";
import shared from "./_components/shared.module.css";

export default function HomePage() {
  return (
    <div className={shared.page}>
      <h1 className={shared.heading}>Books you can listen to</h1>
      <p className={shared.lede}>
        Turn your own e-books into audiobooks. Everything is read aloud on this computer.
      </p>
      <UploadZone />
      <BookList />
    </div>
  );
}
