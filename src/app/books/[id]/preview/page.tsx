import { PreviewView } from "@/ui/features/preview/PreviewView";

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PreviewView key={id} id={id} />;
}
