// Puts together what gets handed over: the plugin folder to install, the demo note,
// the README with its pictures, and the source. Usage: node pack.mjs [output folder]
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.dirname(new URL(import.meta.url).pathname);
const { version } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'release'));
const name = `kifu-${version}`;
const top = path.join(outDir, name);
rmSync(top, { recursive: true, force: true });
mkdirSync(top, { recursive: true });

const copy = (from, to) => cpSync(path.join(root, from), path.join(top, to), { recursive: true });

// 1. the folder to drop into <vault>/.obsidian/plugins/
for (const f of ['main.js', 'manifest.json', 'styles.css']) copy(f, path.join('kifu', f));
// 2. things to read and try
copy('README.md', 'README.md');
copy('docs', 'docs');
copy('demo', 'demo');
// 3. the source, complete enough to rebuild and to run every check
for (const f of ['src', 'demo', 'docs', 'README.md', 'manifest.json', 'styles.css', 'package.json', 'package-lock.json', 'tsconfig.json', 'esbuild.config.mjs', 'eslint.config.mts', 'run-tests.mjs', 'pack.mjs']) {
	copy(f, path.join('source', f));
}
for (const f of ['core.test.ts', 'session.test.ts', 'markdown.test.ts']) copy(path.join('tests', f), path.join('source/tests', f));
for (const f of ['obsidian-mock.js', 'cm-lp.ts', 'index.html', 'lib.mjs', 'interact.mjs', 'editor.mjs', 'identity.mjs', 'monkey.mjs', 'perf.mjs', 'shots.mjs', 'shots2.mjs', 'docs.mjs']) {
	copy(path.join('tests/harness', f), path.join('source/tests/harness', f));
}

const zip = path.join(outDir, `${name}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-q', '-X', zip, name], { cwd: outDir });
console.log(existsSync(zip) ? `wrote ${zip}` : 'zip failed');
