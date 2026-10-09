"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { ChallengeRunner, type ChallengeRunnerHandle } from "@/components/challenge-runner";
import { Button } from "@/components/ui/button";
import { DEMO_PROGRESS_KEY, type DemoLesson } from "@/lib/demo-lessons";
import type { PytestResult } from "@/lib/pyodide";

export function DemoWorkspace({ lesson, nextSlug }: { lesson: DemoLesson; nextSlug: string | null }) {
  const runner = useRef<ChallengeRunnerHandle>(null);
  const [hint, setHint] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [passed, setPassed] = useState(false);
  const handleFilesChange = useCallback(() => setPassed(false), []);
  const handleResult = useCallback((result: PytestResult) => {
    const success = result.exitCode === 0 && result.tests.length > 0 && result.tests.every((test) => test.status === "passed");
    setPassed(success);
    if (success) {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(DEMO_PROGRESS_KEY) ?? "[]");
        const completed = Array.isArray(saved) ? saved.filter((slug): slug is string => typeof slug === "string") : [];
        localStorage.setItem(DEMO_PROGRESS_KEY, JSON.stringify([...new Set([...completed, lesson.slug])]));
      } catch { /* Tests still work when browser storage is unavailable. */ }
    }
  }, [lesson.slug]);

  return (
    <div className="grid flex-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex min-h-[620px] min-w-0 flex-col rounded-lg border p-3" aria-label="Demo coding workspace">
        <ChallengeRunner ref={runner} challengeSlug={`demo-${lesson.slug}`} challengeId={`demo-${lesson.slug}`} repoTemplateUrl={null} branch="main" config={lesson.config} nextSlug={null} demo onRunComplete={handleResult} onFilesChange={handleFilesChange} onStuck={() => setHint((current) => Math.max(1, current))} />
      </section>
      <aside className="space-y-4" aria-label="Demo mentor">
        <section className="rounded-lg border bg-slate-50 p-5"><h2 className="font-semibold">Your goal</h2><p className="mt-2 text-sm text-slate-600">{lesson.goal}</p><p className="mt-4 text-xs text-slate-500">Start by running the tests. Open a failing test to see what needs fixing, then edit the Python file.</p></section>
        <section className="rounded-lg border p-5">
          <h2 className="font-semibold">Demo mentor</h2><p className="mt-1 text-xs text-muted-foreground">Guided sample hints · no live AI calls</p>
          <div className="mt-4 flex gap-2">{[1, 2, 3].map((level) => <Button key={level} size="sm" variant={hint === level ? "default" : "outline"} onClick={() => setHint(level)} aria-pressed={hint === level}>Hint {level}</Button>)}</div>
          <div aria-live="polite" className="mt-4 rounded-md bg-blue-50 p-4 text-sm leading-relaxed text-slate-700">{hint ? lesson.hints[hint - 1] : "Try the exercise first. Hint 1 asks a question, hint 2 points to the bug, and hint 3 gives pseudocode."}</div>
          <Button variant="outline" className="mt-4 w-full" onClick={() => setRevealed(true)}>Show sample solution</Button>
          {revealed && <div className="mt-4 space-y-3"><p className="text-xs text-muted-foreground">This replaces the editable file. Run the tests afterwards to check the result.</p><pre className="overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">{Object.values(lesson.solution).join("\n")}</pre><Button className="w-full" onClick={() => { runner.current?.applyFiles(lesson.solution); setRevealed(false); }}>Apply sample solution</Button></div>}
        </section>
        {passed && <section aria-live="polite" className="rounded-lg border border-green-300 bg-green-50 p-5"><h2 className="font-semibold text-green-900">✓ Demo lesson complete</h2><p className="mt-2 text-sm text-green-800">All tests passed. Progress saved in this browser.</p><Link className="mt-4 inline-block font-semibold text-green-900 underline" href={nextSlug ? `/demo/${nextSlug}` : "/demo"}>{nextSlug ? "Try the next lesson →" : "Back to demo lessons →"}</Link></section>}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">Want the full curriculum and live AI feedback? <Link href="/login" className="underline">Sign in to continue.</Link></p>
      </aside>
    </div>
  );
}
