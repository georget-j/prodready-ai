// Exercise starter -> edit -> rerun in ONE Python process, like Pyodide.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const checkPytest = spawnSync('python', ['-c', 'import pytest'], { encoding: 'utf8' });
if (checkPytest.status !== 0) throw new Error('Install pytest before running the demo fixture checks');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/demo-lessons.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {} };
vm.runInNewContext(compiled, context);
const worker = fs.readFileSync(path.join(__dirname, '../src/lib/pyodide-worker.ts'), 'utf8');
const bootstrap = worker.match(/const exit = await py\.runPythonAsync\(`([\s\S]*?)`\);/)[1];
for (const lesson of context.exports.DEMO_LESSONS) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'prodready-demo-'));
  try {
    for (const filename of Object.keys(lesson.solution)) {
      if (!lesson.config.editable.includes(filename)) throw new Error('Solution replaces a read-only test file');
    }
    // Replace the sandbox root with a disposable local directory for this test.
    const code = bootstrap.replaceAll('/home/pyodide', folder).replace('${argsLiteral}', JSON.stringify(['-q', ...lesson.config.tests.map(test => test.id)]));
    const run = spawnSync('python', ['-c', `
import json,sys,pathlib
payload=json.load(sys.stdin)
for filename,content in payload['inline'].items():
    pathlib.Path(filename).write_text(content)
state={}
exec(payload['bootstrap'],state)
assert int(state['exit_code']) == 1, 'Starter should fail real tests'
for filename,content in payload['solution'].items():
    pathlib.Path(filename).write_text(content)
exec(payload['bootstrap'],state)
assert int(state['exit_code']) == 0, 'Edited solution should pass on a second run'
`], { cwd: folder, encoding: 'utf8', input: JSON.stringify({inline: lesson.config.inline, solution: lesson.solution, bootstrap: code}) });
    if (run.status !== 0) throw new Error(`${lesson.slug}: edit/rerun failed\n${run.stdout}\n${run.stderr}`);
    console.log(`${lesson.slug}: starter fails; edited solution passes all ${lesson.config.tests.length} tests in the same runtime`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
