/// <reference lib="webworker" />
/**
 * Pyodide Web Worker.
 *
 * Runs Pyodide off the main thread so the UI never freezes during a Run.
 * Communicates via a simple `{ id, fn, args }` → `{ id, result, error }` RPC.
 *
 * Supported `fn` values:
 *   init                       — load Pyodide. Resolves when ready.
 *   ensurePytest               — install pytest via micropip. Idempotent.
 *   ensureMatplotlib           — install matplotlib (Agg backend). Idempotent.
 *   ensureDataset              — fetch /data/quant/<slug>.csv into the FS.
 *   runPythonStdout            — run user code with the step watchdog.
 *   runPythonAndCaptureFigure  — run user code + grab the active figure as SVG.
 *   runPytest                  — write a file tree + run pytest.
 *   reset                      — discard the current Pyodide instance.
 *
 * The watchdog (sys.settrace) catches infinite loops. The trace function
 * lives at module level in Python and is reused across runs.
 */

// `self` is the worker global. We're compiled with both DOM + WebWorker
// libs, so cast through `unknown` to address it as DedicatedWorkerGlobalScope
// without colliding with the DOM `self`.
const workerSelf = self as unknown as DedicatedWorkerGlobalScope;
declare function importScripts(...urls: string[]): void;
type PyodideAPI = {
  FS: {
    writeFile(path: string, content: string): void;
    mkdir(path: string): void;
    analyzePath(path: string): { exists: boolean };
  };
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(names: string | string[]): Promise<void>;
  pyimport(name: string): { install(deps: string[]): Promise<void> };
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  globals: {
    set(name: string, value: unknown): void;
    delete(name: string): boolean;
  };
};
declare const loadPyodide: (options: {
  indexURL: string;
}) => Promise<PyodideAPI>;

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);

const WATCHDOG_MAX_STEPS = 200_000;

// One-time Python setup: define the watchdog trace function. The exec call
// in runPythonStdout reuses it; we don't re-define on every run.
const WATCHDOG_BOOTSTRAP = `
import sys as _pyodide_sys

_pyodide_step_count = [0]
_PYODIDE_MAX_STEPS = ${WATCHDOG_MAX_STEPS}

def _pyodide_watchdog(frame, event, arg):
    if event == 'line':
        _pyodide_step_count[0] += 1
        if _pyodide_step_count[0] > _PYODIDE_MAX_STEPS:
            raise RuntimeError(
                "Aborted after %d steps — this looks like an infinite loop. "
                "Check your loop condition: does it actually become False eventually? "
                "(For example, in a 'while count > 0' loop, count needs to get smaller.)"
                % _PYODIDE_MAX_STEPS
            )
    return _pyodide_watchdog

def _pyodide_run_user(code: str) -> None:
    _pyodide_step_count[0] = 0
    _pyodide_sys.settrace(_pyodide_watchdog)
    try:
        exec(compile(code, '<lesson>', 'exec'), {'__name__': '__main__'})
    finally:
        _pyodide_sys.settrace(None)
        # Always restore stdout/stderr in case user code reassigned them.
        _pyodide_sys.stdout = _pyodide_sys.__stdout__
        _pyodide_sys.stderr = _pyodide_sys.__stderr__
`;

let pyodide: PyodideAPI | null = null;
let initPromise: Promise<void> | null = null;
let pytestPromise: Promise<void> | null = null;
let matplotlibPromise: Promise<void> | null = null;

// Track the last-written tree signature so duplicate runs skip the FS write.
let lastTreeSignature: string | null = null;

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    await pyodide.runPythonAsync(WATCHDOG_BOOTSTRAP);
  })().catch((exc) => {
    initPromise = null;
    pyodide = null;
    throw exc;
  });
  return initPromise;
}

async function ensurePytest(): Promise<void> {
  if (pytestPromise) return pytestPromise;
  if (!pyodide) throw new Error("Pyodide not ready");
  const py = pyodide;
  pytestPromise = (async () => {
    await py.loadPackage(["micropip"]);
    const micropip = py.pyimport("micropip");
    await micropip.install(["pytest"]);
  })().catch((exc) => {
    pytestPromise = null;
    throw exc;
  });
  return pytestPromise;
}

const loadedDatasets = new Set<string>();

async function ensureDataset(slug: string): Promise<void> {
  if (!pyodide) throw new Error("Pyodide not ready");
  if (loadedDatasets.has(slug)) return;
  // Tight allow-list — only the known bundled tickers can be requested.
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Invalid dataset slug: ${slug}`);
  }
  const url = `/data/quant/${slug}.csv`;
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Couldn't fetch ${url} (HTTP ${res.status})`);
  const body = await res.text();
  // Write to a stable in-FS path mirroring the URL.
  const fsPath = `/data/quant/${slug}.csv`;
  const dir = "/data/quant";
  if (!pyodide.FS.analyzePath("/data").exists) pyodide.FS.mkdir("/data");
  if (!pyodide.FS.analyzePath(dir).exists) pyodide.FS.mkdir(dir);
  pyodide.FS.writeFile(fsPath, body);
  loadedDatasets.add(slug);
}

async function ensureMatplotlib(): Promise<void> {
  if (matplotlibPromise) return matplotlibPromise;
  if (!pyodide) throw new Error("Pyodide not ready");
  const py = pyodide;
  matplotlibPromise = (async () => {
    // Pyodide ships a pre-built matplotlib package; loadPackage is faster
    // than micropip for it because there's no resolution step.
    await py.loadPackage(["matplotlib"]);
    // Force the Agg backend so plt.show() never tries to open a window.
    await py.runPythonAsync(
      "import matplotlib\nmatplotlib.use('Agg', force=True)\n",
    );
  })().catch((exc) => {
    matplotlibPromise = null;
    throw exc;
  });
  return matplotlibPromise;
}

function writeTree(files: Record<string, string>): void {
  if (!pyodide) throw new Error("Pyodide not ready");
  for (const [rawPath, body] of Object.entries(files)) {
    const abs = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const segments = abs.split("/").filter(Boolean);
    let cursor = "";
    for (let i = 0; i < segments.length - 1; i++) {
      cursor = `${cursor}/${segments[i]}`;
      if (!pyodide.FS.analyzePath(cursor).exists) {
        pyodide.FS.mkdir(cursor);
      }
    }
    pyodide.FS.writeFile(abs, body);
  }
}

async function runPythonStdout(
  code: string,
): Promise<{ stdout: string; error: string | null }> {
  if (!pyodide) throw new Error("Pyodide not ready");
  const py = pyodide;
  const outLines: string[] = [];
  const errLines: string[] = [];
  try {
    py.setStdout({ batched: (s) => outLines.push(s) });
    py.setStderr({ batched: (s) => errLines.push(s) });
  } catch (exc) {
    return {
      stdout: "",
      error: `Couldn't attach stdout: ${exc instanceof Error ? exc.message : String(exc)}. Try the Reset Python button.`,
    };
  }
  try {
    py.globals.set("_pyodide_user_code_in", code);
    await py.runPythonAsync("_pyodide_run_user(_pyodide_user_code_in)");
    return { stdout: outLines.join("\n"), error: errLines.join("\n") || null };
  } catch (exc) {
    return {
      stdout: outLines.join("\n"),
      error: exc instanceof Error ? exc.message : String(exc),
    };
  } finally {
    try {
      py.globals.delete("_pyodide_user_code_in");
    } catch {
      // ignore
    }
  }
}

type FigureRun = {
  stdout: string;
  svg: string | null;
  error: string | null;
};

async function runPythonAndCaptureFigure(code: string): Promise<FigureRun> {
  if (!pyodide) throw new Error("Pyodide not ready");
  const py = pyodide;
  const outLines: string[] = [];
  const errLines: string[] = [];
  try {
    py.setStdout({ batched: (s) => outLines.push(s) });
    py.setStderr({ batched: (s) => errLines.push(s) });
  } catch (exc) {
    return {
      stdout: "",
      svg: null,
      error: `Couldn't attach stdout: ${exc instanceof Error ? exc.message : String(exc)}. Try the Reset Python button.`,
    };
  }
  try {
    // Reset any prior figures so we capture only this run's plot.
    await py.runPythonAsync(
      "import matplotlib.pyplot as plt\nplt.close('all')",
    );
    py.globals.set("_pyodide_user_code_in", code);
    await py.runPythonAsync("_pyodide_run_user(_pyodide_user_code_in)");
    // Grab the active figure (whatever the learner drew last) as SVG.
    const svg = (await py.runPythonAsync(`
import io as _io
import matplotlib.pyplot as plt
_fig = plt.gcf()
if not _fig.get_axes():
    _svg_out = ""
else:
    _buf = _io.StringIO()
    _fig.savefig(_buf, format='svg', bbox_inches='tight')
    _svg_out = _buf.getvalue()
_svg_out
`)) as string;
    return {
      stdout: outLines.join("\n"),
      svg: svg || null,
      error: errLines.join("\n") || null,
    };
  } catch (exc) {
    return {
      stdout: outLines.join("\n"),
      svg: null,
      error: exc instanceof Error ? exc.message : String(exc),
    };
  } finally {
    try {
      py.globals.delete("_pyodide_user_code_in");
    } catch {
      // ignore
    }
  }
}

// ---- pytest output parsing (mirrors the previous parseVerboseOutput) ----
type TestStatus = "passed" | "failed" | "error" | "skipped";
type TestRow = { name: string; status: TestStatus };
type FailureLocations = Record<string, number[]>;

const VERBOSE_LINE_RE =
  /^(.+?::[\w[\]\-.]+)\s+(PASSED|FAILED|ERROR|SKIPPED)\b/i;
const TB_LOCATION_RE = /^([\w./-]+\.py):(\d+):/;
const STATUS_MAP: Record<string, TestStatus> = {
  PASSED: "passed",
  FAILED: "failed",
  ERROR: "error",
  SKIPPED: "skipped",
};

function parseVerboseOutput(text: string): {
  tests: TestRow[];
  summary: string;
  failureLocations: FailureLocations;
} {
  const tests: TestRow[] = [];
  let summary = "";
  const failureLocations: FailureLocations = {};
  // Pyodide batched stdout can flush a test node ID before its status.
  // Rejoin that known pair before parsing, without merging traceback lines.
  const normalised = text.replace(
    /^(.+?::[^\s]+)[ \t]*\n\s*(PASSED|FAILED|ERROR|SKIPPED)\b/gim,
    "$1 $2",
  );
  for (const rawLine of normalised.split("\n")) {
    const line = rawLine.trimStart();
    const statusMatch = VERBOSE_LINE_RE.exec(line);
    if (statusMatch) {
      tests.push({
        name: statusMatch[1].split("::").pop() ?? statusMatch[1],
        status: STATUS_MAP[statusMatch[2].toUpperCase()],
      });
      continue;
    }
    if (/=+\s*\d+ (passed|failed|error|skipped)/.test(line)) {
      summary = line.replace(/=/g, "").trim();
      continue;
    }
    const tbMatch = TB_LOCATION_RE.exec(line);
    if (tbMatch) {
      const path = tbMatch[1];
      const lineNumber = parseInt(tbMatch[2], 10);
      if (
        path.startsWith("tests/") ||
        path.includes("/_pytest/") ||
        path.includes("/pluggy/") ||
        path.includes("/python3") ||
        path.startsWith("/lib/")
      ) {
        continue;
      }
      const existing = failureLocations[path] ?? [];
      if (!existing.includes(lineNumber)) {
        failureLocations[path] = [...existing, lineNumber];
      }
    }
  }
  return { tests, summary, failureLocations };
}

type PytestResult = {
  exitCode: number;
  output: string;
  tests: TestRow[];
  summary: string;
  failureLocations: FailureLocations;
};

async function runPytest(
  files: Record<string, string>,
  pytestArgs: string[],
): Promise<PytestResult> {
  if (!pyodide) throw new Error("Pyodide not ready");
  const py = pyodide;

  // Files are written under /home/pyodide/. Skip the FS write when nothing
  // changed since the last call — JSON.stringify on a sorted-keys map gives
  // us a stable signature that catches both content and added/removed files.
  const signature = JSON.stringify(files, Object.keys(files).sort());
  if (signature !== lastTreeSignature) {
    const rooted: Record<string, string> = {};
    for (const [p, body] of Object.entries(files)) {
      rooted[`/home/pyodide/${p}`] = body;
    }
    writeTree(rooted);
    lastTreeSignature = signature;
  }

  const outLines: string[] = [];
  try {
    py.setStdout({ batched: (s) => outLines.push(s) });
    py.setStderr({ batched: (s) => outLines.push(s) });
  } catch (exc) {
    return {
      exitCode: -1,
      output: `Couldn't attach stdout: ${exc instanceof Error ? exc.message : String(exc)}`,
      tests: [],
      summary: "Runner error — try Reset Python",
      failureLocations: {},
    };
  }

  const argsLiteral = JSON.stringify([
    "-v",
    "--tb=short",
    "--no-header",
    ...pytestArgs,
  ]);

  try {
    const exit = await py.runPythonAsync(`
import sys, os
sys.path.insert(0, "/home/pyodide")
os.chdir("/home/pyodide")
import pytest
exit_code = pytest.main(${argsLiteral})
int(exit_code)
`);
    const output = outLines.join("\n");
    const { tests, summary, failureLocations } = parseVerboseOutput(output);
    return {
      exitCode: Number(exit),
      output,
      tests,
      summary:
        summary ||
        (Number(exit) === 0 ? "All tests passed" : "Some tests failed"),
      failureLocations,
    };
  } catch (exc) {
    return {
      exitCode: -1,
      output: `${outLines.join("\n")}\n\n[runner threw before pytest could finish]\n${exc instanceof Error ? exc.message : String(exc)}`,
      tests: [],
      summary: "Runner error — try Reset Python",
      failureLocations: {},
    };
  }
}

// ---- message dispatcher ----
type Envelope = { id: number; fn: string; args?: unknown };
type Reply = { id: number; result: unknown } | { id: number; error: string };

workerSelf.addEventListener(
  "message",
  async (event: MessageEvent<Envelope>) => {
    const { id, fn, args } = event.data;
    const reply = (msg: Reply) => workerSelf.postMessage(msg);
    try {
      switch (fn) {
        case "init":
          await ensureInit();
          reply({ id, result: null });
          return;
        case "ensurePytest":
          await ensureInit();
          await ensurePytest();
          reply({ id, result: null });
          return;
        case "ensureMatplotlib":
          await ensureInit();
          await ensureMatplotlib();
          reply({ id, result: null });
          return;
        case "ensureDataset":
          await ensureInit();
          await ensureDataset((args as { slug: string }).slug);
          reply({ id, result: null });
          return;
        case "runPythonStdout": {
          await ensureInit();
          const result = await runPythonStdout((args as { code: string }).code);
          reply({ id, result });
          return;
        }
        case "runPythonAndCaptureFigure": {
          await ensureInit();
          await ensureMatplotlib();
          const result = await runPythonAndCaptureFigure(
            (args as { code: string }).code,
          );
          reply({ id, result });
          return;
        }
        case "runPytest": {
          await ensureInit();
          await ensurePytest();
          const a = args as {
            files: Record<string, string>;
            pytestArgs: string[];
          };
          const result = await runPytest(a.files, a.pytestArgs);
          reply({ id, result });
          return;
        }
        case "reset":
          // The proxy terminates this worker instead. We only get here if
          // someone calls the in-band reset; clear caches so a follow-up
          // init re-bootstraps.
          pyodide = null;
          initPromise = null;
          pytestPromise = null;
          matplotlibPromise = null;
          loadedDatasets.clear();
          lastTreeSignature = null;
          reply({ id, result: null });
          return;
        default:
          reply({ id, error: `Unknown fn: ${fn}` });
      }
    } catch (exc) {
      reply({ id, error: exc instanceof Error ? exc.message : String(exc) });
    }
  },
);

