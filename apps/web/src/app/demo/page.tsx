import Link from "next/link";
import { DEMO_LESSONS } from "@/lib/demo-lessons";

export const metadata = { title: "Try the public demo | ProdReady AI" };

export default function DemoPage() {
  return (
    <div className="space-y-10 py-10">
      <section className="rounded-xl border border-blue-200 bg-blue-50 p-6 sm:p-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-blue-700">Public demo · No account needed</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">From a bug to passing tests.</h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">Try three bite-sized production coding exercises. Edit real Python, run real tests in your browser, and use guided hints when you get stuck.</p>
        <Link href="/demo/basket-total" className="mt-6 inline-flex rounded-md bg-blue-700 px-5 py-3 font-semibold text-white hover:bg-blue-800">Start the demo →</Link>
        <p className="mt-3 text-sm text-slate-600">Sample exercises and progress stay in this browser. Guided sample hints are included; live AI mentoring is available in signed-in lessons.</p>
      </section>
      <section aria-label="Demo workflow" className="grid gap-3 sm:grid-cols-4">
        {["Read the brief", "Edit the Python", "Run the tests", "Use hints & improve"].map((step, i) => (
          <div key={step} className="rounded-lg border p-4"><p className="text-xs font-semibold text-blue-700">STEP {i + 1}</p><p className="mt-2 font-medium">{step}</p></div>
        ))}
      </section>
      <section aria-label="Sample lessons" className="grid gap-4 md:grid-cols-3">
        {DEMO_LESSONS.map((lesson, i) => (
          <article key={lesson.slug} className="flex flex-col rounded-xl border p-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">0{i + 1} · {lesson.track}</p>
            <h2 className="mt-3 text-xl font-semibold">{lesson.title}</h2>
            <p className="mt-3 flex-1 text-sm text-muted-foreground">{lesson.description}</p>
            <p className="mt-4 text-xs text-muted-foreground">3 tests · Python in your browser</p>
            <Link className="mt-4 font-semibold text-blue-700 hover:underline" href={`/demo/${lesson.slug}`}>Try this lesson →</Link>
          </article>
        ))}
      </section>
    </div>
  );
}
