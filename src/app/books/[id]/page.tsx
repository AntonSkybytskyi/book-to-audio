import { BookView } from "../../_components/BookView";

export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookView key={id} id={id} />;
}
