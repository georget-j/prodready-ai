// Verify that each shipped exercise fails initially and passes with its sample solution.
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
for (const lesson of context.exports.DEMO_LESSONS) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'prodready-demo-'));
  try {
    for (const [filename, content] of Object.entries(lesson.config.inline)) {
      fs.writeFileSync(path.join(folder, filename), content);
    }
    const run = () => spawnSync('python', ['-m', 'pytest', '-q', ...lesson.config.tests.map(test => test.id)], { cwd: folder, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const initial = run();
    if (initial.status !== 1) throw new Error(`${lesson.slug}: initial exercise should fail tests\n${initial.stdout}\n${initial.stderr}`);
    for (const [filename, content] of Object.entries(lesson.solution)) {
      if (!lesson.config.editable.includes(filename)) throw new Error('Solution replaces a read-only test file');
      fs.writeFileSync(path.join(folder, filename), content);
    }
    const solved = run();
    if (solved.status !== 0) throw new Error(`${lesson.slug}: sample solution should pass\n${solved.stdout}\n${solved.stderr}`);
    console.log(`${lesson.slug}: starter fails; solution passes all ${lesson.config.tests.length} tests`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
