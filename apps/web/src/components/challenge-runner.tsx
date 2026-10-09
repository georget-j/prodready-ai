"use client";

import dynamic from "next/dynamic";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  detectUnsupportedFeatures,
  ensureDataset,
  ensurePytest,
  getPyodide,
  resetPyodide,
  runPytest,
  type PytestResult,
  type TestStatus,
} from "@/lib/pyodide";
import type { ChallengeRunnerConfig, TestCase } from "@/lib/featured-files";
import { Glossary } from "@/components/glossary";
import { celebrate } from "@/lib/celebrate";

/** Imperative surface the parent (ChallengeView) calls into to drive the
 * editor — e.g. when the mentor chat says "look at app/orders.py:24" or when
 * "Show me the answer" returns a replacement set of files. */
export type ChallengeRunnerHandle = {
  jumpTo: (path: string, line: number | null) => void;
  applyFiles: (next: Record<string, string>) => void;
};

type FailureExplanation = {
  test_name: string;
  what_was_checked: string;
  what_happened: string;
  where_to_look: string;
  file?: string | null;
  line?: number | null;
  function?: string | null;
};

// Minimal Monaco surface we use — typed locally so we don't import editor
// types eagerly (which would break Next.js SSR).
type MonacoEditorRef = {
  revealLineInCenter: (line: number) => void;
  deltaDecorations: (oldIds: string[], newDecos: unknown[]) => string[];
  setPosition: (pos: { lineNumber: number; column: number }) => void;
  focus: () => void;
};

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <p className="p-6 text-center text-xs text-muted-foreground">
      Loading editor…
    </p>
  ),
});

const RAW_BASE = "https://raw.githubusercontent.com";
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const SUBMIT_REPO_URL = "https://prodready-ai.vercel.app/in-browser";
const AUTO_ADVANCE_MS = 6000;

type Props = {
  challengeSlug: string;
  challengeId: string;
  /**
   * Source repo for the file scaffolds. `null` when `config.inline` is set
   * (Quant mini-projects ship their scaffolds inline so they don't need a
   * GitHub mirror).
   */
  repoTemplateUrl: string | null;
  branch: string;
  config: Extract<ChallengeRunnerConfig, { mode: "pyodide" }>;
  /** Slug of the next lesson in the same track, for auto-advance on
   * successful submission. Null when this is the last lesson. */
  nextSlug: string | null;
  /** Public sample mode skips authenticated AI and submission calls. */
  demo?: boolean;
  onRunComplete?: (result: PytestResult) => void;
  /** Called when the learner clicks 'Stuck?'. Receives a pre-baked
   * message the parent can forward to the mentor chat. */
  onStuck?: (message: string) => void;
  /** Snapshot callback fired each time the file map changes (used by the
   * show-answer flow to know what to send to the API). */
  onFilesChange?: (files: Record<string, string>) => void;
};

type ExplainState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; failures: FailureExplanation[] }
  | { kind: "error"; message: string };

type PyodideState =
  | { kind: "cold" }
  | { kind: "warming" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: PytestResult };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "passed"; submissionId: string }
  | { kind: "error"; message: string };

function parseOwnerRepo(
  url: string | null,
): { owner: string; repo: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const [, owner, repo] = u.pathname.split("/");
    return owner && repo ? { owner, repo: repo.replace(/\.git$/, "") } : null;
  } catch {
    return null;
  }
}

function languageFromPath(p: string): string {
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

function storageKey(slug: string, path: string): string {
  return `prodready:edit:${slug}:${path}`;
}

function shortName(test: TestCase): string {
  return test.label ?? test.id.split("::").pop() ?? test.id;
}

function statusEmoji(status: TestStatus): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "error":
      return "!";
    case "skipped":
      return "—";
  }
}

function statusClass(status: TestStatus | "pending"): string {
  switch (status) {
    case "passed":
      return "text-green-700";
    case "failed":
    case "error":
      return "text-red-700";
    case "skipped":
      return "text-muted-foreground";
    case "pending":
      return "text-muted-foreground";
  }
}

export const ChallengeRunner = forwardRef<ChallengeRunnerHandle, Props>(
  function ChallengeRunner(
    {
      challengeSlug,
      challengeId,
      repoTemplateUrl,
      branch,
      config,
      nextSlug,
      onStuck,
      onFilesChange,
      demo = false,
      onRunComplete,
    },
    ref,
  ) {
    // When `config.inline` is set, file contents come from the generated
    // TS config and we never hit the network. Used by the Quant mini-
    // projects so we don't need a per-project GitHub mirror. Otherwise
    // we fall back to fetching from raw.githubusercontent.com.
    const inlineFiles = config.inline ?? null;
    const meta = inlineFiles ? null : parseOwnerRepo(repoTemplateUrl);
    const allPaths = [...config.editable, ...config.readonly];

    const [files, setFiles] = useState<Record<string, string>>({});
    const [activeTab, setActiveTab] = useState<string>(
      config.editable[0] ?? allPaths[0],
    );
    const [loadError, setLoadError] = useState<string | null>(null);
    const [pyodideState, setPyodideState] = useState<PyodideState>({
      kind: "cold",
    });
    const [runState, setRunState] = useState<RunState>({ kind: "idle" });
    const [submitState, setSubmitState] = useState<SubmitState>({
      kind: "idle",
    });
    const [explainState, setExplainState] = useState<ExplainState>({
      kind: "idle",
    });
    // Which failing-test rows are currently expanded. After each run we
    // auto-expand the first failure (so the learner sees one explanation
    // up-front instead of a wall of red); they can toggle others.
    const [expandedTestIds, setExpandedTestIds] = useState<Set<string>>(
      () => new Set(),
    );
    // Mobile-only slide-up sheet for the result banner + tests panel.
    // Auto-opens after each Run; user can dismiss with ✕ and reopen via
    // the bottom-left pill. On lg+ the wrapper dissolves (lg:contents)
    // and the results render inline in the runner's flex flow.
    const [sheetOpen, setSheetOpen] = useState(false);
    const [failureLocations, setFailureLocations] = useState<
      Record<string, number[]>
    >({});
    const router = useRouter();
    const editorRef = useRef<MonacoEditorRef | null>(null);
    // Decoration ids returned by Monaco; we keep them to clear on next change.
    const decorationIdsRef = useRef<string[]>([]);
    // Result banner — scrolled into view after each test run so the
    // learner sees the outcome (especially failures) without having
    // to scroll past the editor on mobile.
    const resultBannerRef = useRef<HTMLElement | null>(null);

    // Pre-warm Pyodide on mount so the first Run feels instant. Pytest is
    // installed lazily in handleRun via ensurePytest() — we don't pay that
    // cost on every page mount. Datasets declared on the lesson are
    // mounted into the FS here too so `pd.read_csv("/data/quant/spy.csv")`
    // works inside tests.
    const datasets = config.datasets ?? [];
    const datasetsKey = datasets.join(",");
    useEffect(() => {
      let cancelled = false;
      setPyodideState({ kind: "warming" });
      (async () => {
        await getPyodide();
        for (const slug of datasets) {
          await ensureDataset(slug);
        }
      })()
        .then(() => {
          if (!cancelled) setPyodideState({ kind: "ready" });
        })
        .catch((exc) => {
          if (!cancelled) {
            setPyodideState({
              kind: "error",
              message: exc instanceof Error ? exc.message : String(exc),
            });
          }
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [datasetsKey]);

    useEffect(() => {
      if (inlineFiles) {
        // Inline-scaffold path: contents come from the generated config.
        const next: Record<string, string> = {};
        for (const path of allPaths) next[path] = inlineFiles[path] ?? "";
        for (const path of config.editable) {
          const saved =
            typeof window !== "undefined"
              ? window.localStorage.getItem(storageKey(challengeSlug, path))
              : null;
          if (saved !== null) next[path] = saved;
        }
        setFiles(next);
        return;
      }
      if (!meta) {
        setLoadError("Invalid repo URL");
        return;
      }
      let cancelled = false;
      (async () => {
        const entries = await Promise.all(
          allPaths.map(async (path) => {
            const url = `${RAW_BASE}/${meta.owner}/${meta.repo}/${branch}/${path}`;
            try {
              const res = await fetch(url, { cache: "no-cache" });
              return [path, res.ok ? await res.text() : ""] as const;
            } catch {
              return [path, ""] as const;
            }
          }),
        );
        if (cancelled) return;
        const next: Record<string, string> = Object.fromEntries(entries);
        for (const path of config.editable) {
          const saved =
            typeof window !== "undefined"
              ? window.localStorage.getItem(storageKey(challengeSlug, path))
              : null;
          if (saved !== null) next[path] = saved;
        }
        setFiles(next);
      })().catch((exc) => {
        if (!cancelled)
          setLoadError(exc instanceof Error ? exc.message : String(exc));
      });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meta?.owner, meta?.repo, branch, challengeSlug, inlineFiles !== null]);

    const handleEdit = useCallback(
      (value: string | undefined) => {
        if (value === undefined) return;
        setFiles((prev) => ({ ...prev, [activeTab]: value }));
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            storageKey(challengeSlug, activeTab),
            value,
          );
        }
      },
      [activeTab, challengeSlug],
    );

    const handleReset = useCallback(async () => {
      if (
        !confirm("Reset your edits to the original code? This can't be undone.")
      )
        return;
      const next = { ...files };
      if (inlineFiles) {
        for (const path of config.editable) {
          next[path] = inlineFiles[path] ?? "";
          if (typeof window !== "undefined") {
            window.localStorage.removeItem(storageKey(challengeSlug, path));
          }
        }
        setFiles(next);
        setRunState({ kind: "idle" });
        return;
      }
      if (!meta) return;
      const fresh = await Promise.all(
        config.editable.map(async (path) => {
          const url = `${RAW_BASE}/${meta.owner}/${meta.repo}/${branch}/${path}`;
          try {
            const res = await fetch(url, { cache: "no-cache" });
            return [path, res.ok ? await res.text() : null] as const;
          } catch {
            return [path, null] as const;
          }
        }),
      );
      for (const [path, body] of fresh) {
        if (body !== null) next[path] = body;
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(storageKey(challengeSlug, path));
        }
      }
      setFiles(next);
      setRunState({ kind: "idle" });
    }, [meta, inlineFiles, files, config.editable, branch, challengeSlug]);

    const explainFailures = useCallback(
      async (testOutput: string, currentFiles: Record<string, string>) => {
        setExplainState({ kind: "loading" });
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          setExplainState({
            kind: "error",
            message: "Sign in to see AI explanations.",
          });
          return;
        }
        try {
          const response = await fetch(`${API_BASE_URL}/api/ai/explain-tests`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              challenge_id: challengeId,
              test_output: testOutput,
              files: currentFiles,
            }),
          });
          if (!response.ok) {
            setExplainState({
              kind: "error",
              message: `Explanation API ${response.status}`,
            });
            return;
          }
          const data = (await response.json()) as {
            failures: FailureExplanation[];
          };
          setExplainState({ kind: "ready", failures: data.failures });
        } catch (exc) {
          setExplainState({
            kind: "error",
            message: exc instanceof Error ? exc.message : "Explanation failed",
          });
        }
      },
      [challengeId],
    );

    const handleRun = useCallback(async () => {
      // Pre-flight: any user file calling `input()` will hang Pyodide
      // (no stdin in the browser). Surface a clean explanation instead.
      for (const [path, body] of Object.entries(files)) {
        if (config.editable.includes(path)) {
          const issue = detectUnsupportedFeatures(body);
          if (issue) {
            setRunState({
              kind: "done",
              result: {
                exitCode: -1,
                output: `In ${path}: ${issue}`,
                tests: [],
                summary: "Unsupported in the in-browser sandbox",
                failureLocations: {},
              },
            });
            return;
          }
        }
      }
      setRunState({ kind: "running" });
      setExplainState({ kind: "idle" });
      try {
        await getPyodide();
        await ensurePytest();
        setPyodideState({ kind: "ready" });
        const result = await runPytest(
          files,
          config.tests.map((t) => t.id),
        );
        setRunState({ kind: "done", result });
        setFailureLocations(result.failureLocations);
        onRunComplete?.(result);
        const hasFailure = result.tests.some(
          (t) => t.status === "failed" || t.status === "error",
        );
        if (hasFailure && !demo) {
          // Background AI explanation for failing tests.
          void explainFailures(result.output, files);
        } else if (result.exitCode === 0 && result.tests.length > 0) {
          // All tests passed — single confetti burst to mark the win.
          void celebrate();
        }
      } catch (exc) {
        setRunState({
          kind: "done",
          result: {
            exitCode: -1,
            output: exc instanceof Error ? exc.message : String(exc),
            tests: [],
            summary: "Runner error",
            failureLocations: {},
          },
        });
      }
    }, [files, config.editable, config.tests, explainFailures, demo, onRunComplete]);

    /** Open `path` (if among the loaded files) and scroll Monaco to `line`,
     * adding a transient yellow highlight. Used by 'Jump to code →' buttons
     * in the AI explanation panel. */
    const jumpTo = useCallback(
      (path: string, line: number | null | undefined) => {
        if (!(path in files)) return;
        setActiveTab(path);
        if (!line || line < 1) return;
        // Wait for the editor to remount on tab switch before driving the API.
        requestAnimationFrame(() => {
          const editor = editorRef.current;
          if (!editor) return;
          editor.revealLineInCenter(line);
          editor.setPosition({ lineNumber: line, column: 1 });
          decorationIdsRef.current = editor.deltaDecorations(
            decorationIdsRef.current,
            [
              {
                range: {
                  startLineNumber: line,
                  startColumn: 1,
                  endLineNumber: line,
                  endColumn: 1,
                },
                options: {
                  isWholeLine: true,
                  className: "prodready-jump-target",
                  linesDecorationsClassName: "prodready-jump-gutter",
                },
              },
            ],
          );
          editor.focus();
        });
      },
      [files],
    );

    const applyFiles = useCallback(
      (next: Record<string, string>) => {
        setFiles((prev) => {
          const merged = { ...prev, ...next };
          if (typeof window !== "undefined") {
            for (const [p, body] of Object.entries(next)) {
              if (config.editable.includes(p)) {
                window.localStorage.setItem(storageKey(challengeSlug, p), body);
              }
            }
          }
          return merged;
        });
        // Focus a file that was actually replaced so the learner sees the diff.
        const firstReplaced = Object.keys(next).find((p) =>
          config.editable.includes(p),
        );
        if (firstReplaced) setActiveTab(firstReplaced);
      },
      [challengeSlug, config.editable],
    );

    useImperativeHandle(
      ref,
      () => ({
        jumpTo: (path, line) => jumpTo(path, line ?? null),
        applyFiles,
      }),
      [jumpTo, applyFiles],
    );

    // Notify parent of file map snapshot changes so show-answer can grab them.
    useEffect(() => {
      onFilesChange?.(files);
    }, [files, onFilesChange]);

    const editable = config.editable.includes(activeTab);
    const passed = runState.kind === "done" && runState.result.exitCode === 0;

    const handleSubmit = useCallback(async () => {
      if (runState.kind !== "done" || runState.result.exitCode !== 0) return;
      setSubmitState({ kind: "submitting" });
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setSubmitState({ kind: "error", message: "Sign in first." });
        return;
      }
      const response = await fetch(
        `${API_BASE_URL}/api/challenges/${challengeSlug}/submit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            repo_url: SUBMIT_REPO_URL,
            test_output: runState.result.output,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        setSubmitState({
          kind: "error",
          message: `Submit failed (${response.status}): ${body.slice(0, 200)}`,
        });
        return;
      }
      const data = await response.json();
      setSubmitState({ kind: "passed", submissionId: data.id });
    }, [runState, challengeSlug]);

    // Auto-advance to the next lesson once the submission has been
    // accepted. Mirrors the predict/fillblank/matplot pass UX so pyodide
    // lessons don't dead-end at a submission detail page. The countdown
    // can be cancelled by hovering the success card (sets autoCancelled).
    const [autoCancelled, setAutoCancelled] = useState(false);
    useEffect(() => {
      if (submitState.kind !== "passed") return;
      if (!nextSlug || autoCancelled) return;
      const t = setTimeout(() => {
        router.push(`/challenges/${nextSlug}`);
      }, AUTO_ADVANCE_MS);
      return () => clearTimeout(t);
    }, [submitState, nextSlug, autoCancelled, router]);

    // Build a per-test view by joining config.tests with the parsed pytest output
    // and the AI explanation, if any.
    function findExplanation(t: TestCase): FailureExplanation | undefined {
      if (explainState.kind !== "ready") return undefined;
      const short = shortName(t);
      return explainState.failures.find((f) => {
        const name = f.test_name;
        return (
          name === t.id ||
          name === short ||
          name.endsWith(`::${short}`) ||
          t.id.endsWith(`::${name}`) ||
          name.includes(short) ||
          short.includes(name)
        );
      });
    }

    const testRows = config.tests.map((t) => {
      const observed =
        runState.kind === "done"
          ? runState.result.tests.find(
              (r) => r.name === shortName(t) || t.id.endsWith(`::${r.name}`),
            )
          : undefined;
      return { ...t, status: observed?.status ?? ("pending" as const) };
    });

    // Auto-open the tests disclosure whenever there are failures the learner
    // needs to read explanations for.
    const failureCount =
      runState.kind === "done"
        ? runState.result.tests.filter(
            (t) => t.status === "failed" || t.status === "error",
          ).length
        : 0;

    // Auto-expand the first failing test on each new run so the learner
    // immediately sees one explanation instead of a list of red rows.
    // Other failures stay collapsed until clicked.
    useEffect(() => {
      if (runState.kind !== "done") return;
      const firstFailed = testRows.find(
        (r) => r.status === "failed" || r.status === "error",
      );
      setExpandedTestIds(firstFailed ? new Set([firstFailed.id]) : new Set());
      // testRows depends on runState; depending on runState here is enough.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runState]);

    // After each completed run: on mobile, slide the results sheet up;
    // on desktop, scroll the result banner into view at the bottom of
    // the visible area so the editor stays visible above.
    useEffect(() => {
      if (runState.kind !== "done") return;
      setSheetOpen(true);
      const raf = requestAnimationFrame(() => {
        resultBannerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "end",
        });
      });
      return () => cancelAnimationFrame(raf);
    }, [runState]);

    const toggleTestExpand = (id: string) =>
      setExpandedTestIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });

    return (
      <section className="flex flex-col gap-3 p-3">
        {pyodideState.kind === "warming" && (
          <div className="flex-none rounded-md border-2 border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            <span aria-hidden="true" className="mr-1.5">
              ⏳
            </span>
            Loading the Python runtime (~10 MB, one-time download). Run tests
            will activate when this banner clears — usually 5–15 seconds.
          </div>
        )}
        {pyodideState.kind === "error" && (
          <div className="flex-none rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
            Couldn&apos;t load Python: {pyodideState.message}
          </div>
        )}

        <section className="flex flex-col gap-2">
          <header className="flex flex-none flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {config.editable.length} editable file
                {config.editable.length === 1 ? "" : "s"} ·{" "}
                {config.readonly.length} read-only (context for the tests)
              </p>
            </div>
            <div className="flex items-center gap-2">
              <details className="relative">
                <summary className="flex h-8 cursor-pointer list-none items-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent">
                  Reset{" "}
                  <span aria-hidden="true" className="ml-1">
                    ▾
                  </span>
                </summary>
                <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-border bg-background shadow-lg">
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={Object.keys(files).length === 0}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                  >
                    <p className="font-medium">Reset code</p>
                    <p className="text-xs text-muted-foreground">
                      Revert your edits to the starting scaffold.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetPyodide();
                      setPyodideState({ kind: "warming" });
                      void getPyodide()
                        .then(() => setPyodideState({ kind: "ready" }))
                        .catch((exc) =>
                          setPyodideState({
                            kind: "error",
                            message:
                              exc instanceof Error ? exc.message : String(exc),
                          }),
                        );
                    }}
                    className="block w-full border-t border-border px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <p className="font-medium">Reset Python</p>
                    <p className="text-xs text-muted-foreground">
                      Wipe the sandbox if the runtime gets stuck.
                    </p>
                  </button>
                </div>
              </details>
              <Button
                size="sm"
                onClick={handleRun}
                disabled={
                  runState.kind === "running" || pyodideState.kind === "warming"
                }
                className="h-10 px-4 text-sm sm:h-9 sm:px-3 sm:text-xs"
              >
                {runState.kind === "running"
                  ? "⏳ Running tests…"
                  : pyodideState.kind === "warming"
                    ? "⏳ Loading Python…"
                    : "▶ Run tests"}
              </Button>
            </div>
          </header>

          {loadError && (
            <p className="text-xs text-red-600">
              Could not load files: {loadError}
            </p>
          )}

          <div className="flex flex-none flex-wrap gap-1 overflow-x-auto border-b border-border">
            {allPaths.map((p) => {
              const isEditable = config.editable.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setActiveTab(p)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-t-md border-b-2 px-3.5 py-2 font-mono text-xs",
                    p === activeTab
                      ? "border-primary bg-muted font-semibold text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                  title={isEditable ? "Editable" : "Read-only"}
                >
                  <span>{p}</span>
                  {!isEditable && <span className="text-[10px]">🔒</span>}
                </button>
              );
            })}
          </div>

          <div className="h-[70vh] min-h-[440px] overflow-hidden rounded-md border border-border lg:h-[55vh] lg:min-h-[300px]">
            <MonacoEditor
              key={activeTab}
              height="100%"
              language={languageFromPath(activeTab)}
              value={files[activeTab] ?? ""}
              onChange={editable ? handleEdit : undefined}
              options={{
                readOnly: !editable,
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 20,
                padding: { top: 10, bottom: 10 },
                scrollBeyondLastLine: false,
                tabSize: 4,
                // Wrap long lines so mobile users never need horizontal
                // scroll inside the editor. On desktop this also keeps
                // long imports / chained method calls visible without a
                // scroll bar.
                wordWrap: "on",
              }}
              theme="vs-light"
              onMount={(editor) => {
                const ed = editor as unknown as MonacoEditorRef;
                editorRef.current = ed;
                const linesForTab = failureLocations[activeTab] ?? [];
                if (linesForTab.length > 0) {
                  decorationIdsRef.current = ed.deltaDecorations(
                    [],
                    linesForTab.map((ln) => ({
                      range: {
                        startLineNumber: ln,
                        startColumn: 1,
                        endLineNumber: ln,
                        endColumn: 1,
                      },
                      options: {
                        isWholeLine: true,
                        className: "prodready-failure-line",
                        linesDecorationsClassName: "prodready-failure-gutter",
                      },
                    })),
                  );
                }
              }}
            />
          </div>
        </section>

        {/* Results sheet — slides up from bottom on mobile, renders
         * inline on lg+ (the `lg:contents` dissolves the wrapper at
         * desktop sizes so children flow in the runner's flex column
         * as before). Auto-opens after each Run; ✕ closes; the
         * bottom-left pill below reopens. */}
        <div
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-t-2 border-primary/40 bg-background shadow-2xl transition-transform duration-300",
            sheetOpen ? "translate-y-0" : "translate-y-full",
            "lg:contents",
          )}
        >
          <div className="flex flex-none items-center justify-between border-b border-border bg-background/95 px-3 py-2 backdrop-blur lg:hidden">
            <span className="text-sm font-semibold">Test results</span>
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
              aria-label="Close test results"
            >
              ✕
            </button>
          </div>
          <div
            className="space-y-3 overflow-y-auto p-3 lg:contents lg:overflow-visible"
            style={{
              paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
            }}
          >
            {runState.kind === "done" && (
              <section
                ref={resultBannerRef}
                className={cn(
                  "flex-none scroll-mt-2 space-y-2 rounded-md border p-3",
                  passed
                    ? "border-green-300 bg-green-50"
                    : "border-red-300 bg-red-50",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {passed
                      ? `✓ ${runState.result.summary || "All tests passed"}`
                      : runState.result.exitCode === -1
                        ? "Runner error"
                        : `✗ ${runState.result.summary || `pytest exited ${runState.result.exitCode}`}`}
                  </p>
                  <div className="flex items-center gap-2">
                    {!passed && onStuck && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const failed = runState.result.tests
                            .filter(
                              (t) =>
                                t.status === "failed" || t.status === "error",
                            )
                            .map((t) => t.name);
                          const list =
                            failed.length > 0
                              ? failed.join(", ")
                              : "the failing test";
                          onStuck(
                            `I ran the tests and ${failed.length || "some"} failed (${list}). I'm not sure where to start — can you walk me through what to look at?`,
                          );
                        }}
                      >
                        I&apos;m stuck — help
                      </Button>
                    )}
                    {!demo && passed && submitState.kind !== "passed" && (
                      <Button
                        size="lg"
                        onClick={handleSubmit}
                        disabled={submitState.kind === "submitting"}
                        className="w-full sm:w-auto"
                      >
                        {submitState.kind === "submitting"
                          ? "Submitting…"
                          : "Submit solution →"}
                      </Button>
                    )}
                  </div>
                </div>
                {submitState.kind === "passed" && (
                  <div
                    onPointerEnter={() => setAutoCancelled(true)}
                    onFocusCapture={() => setAutoCancelled(true)}
                    className="space-y-2 rounded-md border border-green-300 bg-white px-3 py-3"
                  >
                    <p className="text-sm font-semibold text-green-900">
                      ✓ Solution submitted — nice work.
                    </p>
                    {nextSlug ? (
                      <>
                        <Button
                          type="button"
                          className="w-full"
                          onClick={() => router.push(`/challenges/${nextSlug}`)}
                        >
                          Next lesson →
                        </Button>
                        {!autoCancelled ? (
                          <p className="text-center text-[11px] text-green-900/70">
                            Auto-advancing in{" "}
                            {Math.round(AUTO_ADVANCE_MS / 1000)}s …{" "}
                            <button
                              type="button"
                              onClick={() => setAutoCancelled(true)}
                              className="underline hover:no-underline"
                            >
                              Stay on this lesson
                            </button>
                          </p>
                        ) : (
                          <p className="text-center text-[11px] text-green-900/70">
                            Take your time — click Next when you&apos;re ready.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-green-900">
                        You&apos;ve finished the last lesson of this track 🎉
                      </p>
                    )}
                    <p className="text-center text-[11px] text-muted-foreground">
                      <a
                        href={`/submissions/${submitState.submissionId}${nextSlug ? `?next=${nextSlug}` : ""}`}
                        className="underline hover:no-underline"
                      >
                        View submission details
                      </a>
                    </p>
                  </div>
                )}
                {submitState.kind === "error" && (
                  <p className="text-xs text-red-700">{submitState.message}</p>
                )}
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Raw pytest output
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded bg-white p-3 font-mono text-[11px] leading-relaxed">
                    {runState.result.output || "(no output)"}
                  </pre>
                </details>
              </section>
            )}

            <section className="flex flex-col rounded-md border border-border">
              <header className="flex flex-none items-center justify-between border-b border-border bg-muted/30 px-3 py-2 text-sm font-semibold">
                <span>
                  {runState.kind === "done"
                    ? failureCount > 0
                      ? `${failureCount} test${failureCount === 1 ? "" : "s"} failing — fix the top one first`
                      : "All tests passed"
                    : `Tests (${config.tests.length})`}
                </span>
                {explainState.kind === "loading" && (
                  <span className="text-xs font-normal text-muted-foreground">
                    Mentor is explaining failures…
                  </span>
                )}
              </header>
              <ul className="divide-y divide-border">
                {testRows.map((t) => {
                  const ex = findExplanation(t);
                  const showFailureBox =
                    t.status === "failed" || t.status === "error";
                  const isExpanded = expandedTestIds.has(t.id);
                  return (
                    <li key={t.id} className="px-3 py-2.5">
                      <div className="flex items-start gap-3 text-sm">
                        <span
                          className={cn(
                            "w-4 shrink-0 font-mono",
                            statusClass(t.status),
                          )}
                        >
                          {t.status === "pending" ? "·" : statusEmoji(t.status)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs">
                            {shortName(t)}
                          </p>
                          <p className="mt-0.5 text-muted-foreground">
                            {t.description}
                          </p>
                          {showFailureBox && !isExpanded && (
                            <button
                              type="button"
                              onClick={() => toggleTestExpand(t.id)}
                              className="mt-1 text-xs text-red-700 underline-offset-2 hover:underline"
                            >
                              Show details ↓
                            </button>
                          )}
                        </div>
                      </div>
                      {showFailureBox && isExpanded && (
                        <div className="mt-2 ml-7 space-y-2 rounded-md border border-red-200 bg-red-50/60 p-4 text-sm leading-relaxed">
                          {ex ? (
                            <>
                              <p>
                                <span className="font-semibold">
                                  What this test checked:{" "}
                                </span>
                                {ex.what_was_checked}
                              </p>
                              <p>
                                <span className="font-semibold">
                                  What happened:{" "}
                                </span>
                                {ex.what_happened}
                              </p>
                              <p>
                                <span className="font-semibold">
                                  Where to look next:{" "}
                                </span>
                                {ex.where_to_look}
                              </p>
                              {ex.file && ex.file in files && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    jumpTo(ex.file!, ex.line ?? null)
                                  }
                                  className="mt-1 inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                                >
                                  Jump to{" "}
                                  <code className="font-mono">
                                    {ex.file}
                                    {ex.line ? `:${ex.line}` : ""}
                                  </code>{" "}
                                  →
                                </button>
                              )}
                            </>
                          ) : explainState.kind === "loading" ? (
                            <p className="text-muted-foreground">
                              Generating explanation…
                            </p>
                          ) : explainState.kind === "ready" ? (
                            <p className="text-muted-foreground">
                              Mentor returned an explanation but couldn&apos;t
                              match it to this test. Check the raw pytest output
                              below.
                            </p>
                          ) : explainState.kind === "error" ? (
                            <p className="text-muted-foreground">
                              Mentor couldn&apos;t reach the AI (
                              {explainState.message}). Check the raw output
                              below.
                            </p>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => toggleTestExpand(t.id)}
                            className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            Hide details
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </div>

        {/* Reopen-sheet pill — mobile only, shown when results exist
         * but the sheet has been dismissed. Positioned bottom-LEFT so
         * it doesn't conflict with the mentor FAB (bottom-right). */}
        {runState.kind === "done" && !sheetOpen && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={cn(
              "fixed bottom-3 left-3 z-40 rounded-full px-4 py-2 text-xs font-medium text-primary-foreground shadow-lg lg:hidden",
              passed ? "bg-green-600" : "bg-red-600",
            )}
          >
            {passed
              ? "✓ Tests passed — view"
              : `✗ ${failureCount} failing — view`}
          </button>
        )}
      </section>
    );
  },
);

