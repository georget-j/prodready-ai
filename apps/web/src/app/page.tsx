import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <div className="space-y-16 py-12">
      <section className="space-y-6 text-center">
        <h1 className="mx-auto max-w-3xl text-balance text-5xl font-semibold tracking-tight">
          The missing bridge between coding tutorials and your first production
          engineering job.
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
          Realistic Python lessons that run in your browser, guided by an AI
          senior engineer. Debug working-looking code, build from skeletons,
          wire up fake APIs — graduate with portfolio-ready proof of work.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/demo">
            <Button size="lg">Try demo — no sign-in</Button>
          </Link>
          <Link href="/tracks">
            <Button size="lg" variant="outline">
              See the tracks
            </Button>
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <TrackCard
          title="Mental Models for Code"
          tagline="Learn to think about code, not just write it."
          body="Concept-by-concept atoms — variables, references, control flow, recursion, state machines. Each follows a six-stage UNIT (Try, Read, Play, Check, Apply, Reflect) grounded in cognitive-load and productive-failure research."
          href="/tracks/mental-models"
          cta="Start with foundations →"
        />
        <TrackCard
          title="Backend Production"
          tagline="Build real FastAPI services."
          body="Working-looking Python services with subtle bugs, real pytest suites, and an AI code review on every submission. The pattern hiring managers actually see."
          href="/tracks/backend-production-python"
          cta="Start backend track →"
        />
        <TrackCard
          title="Quant Programmer"
          tagline="numpy, pandas, finance from first principles."
          body="56 lessons across 5 stages: floats, returns, options, ML pitfalls, then C for speed. Most lessons are find-the-bug or build-from-skeleton — the way real desks work."
          href="/tracks/quant-programmer"
          cta="Start quant track →"
        />
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        <Feature title="Realistic by default">
          Almost every lesson is debugging working code or implementing a
          skeleton — not filling in blanks. Pytest decides pass/fail; the AI
          guides.
        </Feature>
        <Feature title="AI senior engineer">
          Socratic at hint 1, specific at hint 2, pseudocode at hint 3. Show me
          the answer is the explicit escape hatch.
        </Feature>
        <Feature title="No setup">
          Pyodide runs Python in your browser — no Git, no Docker, no accounts
          to wire up. Edit, run, pass, advance.
        </Feature>
      </section>
    </div>
  );
}

function TrackCard({
  title,
  tagline,
  body,
  href,
  cta,
}: {
  title: string;
  tagline: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border p-6">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm font-medium text-foreground/80">{tagline}</p>
      <p className="mt-3 flex-1 text-sm text-muted-foreground">{body}</p>
      <div className="mt-4">
        <Link href={href}>
          <Button size="sm">{cta}</Button>
        </Link>
      </div>
    </div>
  );
}

function Feature({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-6">
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

