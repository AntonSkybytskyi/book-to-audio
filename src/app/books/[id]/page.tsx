import { BookView } from "@/ui/features/book/BookView";

export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookView key={id} id={id} />;
}
