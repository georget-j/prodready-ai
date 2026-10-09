import Link from "next/link";
import { notFound } from "next/navigation";
import { DemoWorkspace } from "@/components/demo-workspace";
import { DEMO_LESSONS } from "@/lib/demo-lessons";

export function generateStaticParams() {
  return DEMO_LESSONS.map(({ slug }) => ({ slug }));
}

export default async function DemoLessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const index = DEMO_LESSONS.findIndex((lesson) => lesson.slug === slug);
  if (index < 0) notFound();
  const lesson = DEMO_LESSONS[index];
  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col gap-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <Link href="/demo" className="text-blue-700 hover:underline">← All demo lessons</Link>
        <span className="rounded-full bg-blue-50 px-3 py-1 font-semibold text-blue-700">Public demo · No account needed · {index + 1} / {DEMO_LESSONS.length}</span>
      </div>
      <header><p className="text-xs text-muted-foreground">{lesson.track}</p><h1 className="mt-1 text-2xl font-semibold">{lesson.title}</h1><p className="mt-2 text-sm text-muted-foreground">{lesson.description}</p></header>
      <DemoWorkspace key={slug} lesson={lesson} nextSlug={DEMO_LESSONS[index + 1]?.slug ?? null} />
    </div>
  );
}
